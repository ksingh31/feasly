import { DIALOG_DATA } from '@angular/cdk/dialog';
import type { ComponentType } from '@angular/cdk/portal';
import { Component, DestroyRef, Injector, OnInit, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import {
  KitDateTimePipe,
  KitMoneyPipe,
  StatusChipComponent,
  TimelineComponent,
  UiButtonComponent,
  UiDrawerComponent,
  UiDrawerRef,
  UiModalService,
} from '@app/shared/ui';
import { formatInvoiceTax } from '../../shared/utils/invoice-tax';
import { invoiceRecoveryState, netPaidCents } from '../../shared/utils/invoice-recovery';
import { ClearAdminInvoiceDetail, LoadAdminInvoiceDetail, LoadAdminInvoices } from './admin-invoices.actions';
import { AdminInvoicesState } from './admin-invoices.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { LoadBillingHealth } from './billing-health.actions';
import type { AdminInvoiceActionData } from './admin-invoice-action-modal';
import { AdminInvoiceRateModalComponent } from './admin-invoice-rate-modal.component';
import { AdminInvoiceMethodModalComponent } from './admin-invoice-method-modal.component';
import { AdminInvoicePaymentModalComponent } from './admin-invoice-payment-modal.component';
import { AdminInvoiceRefundModalComponent } from './admin-invoice-refund-modal.component';
import { AdminInvoiceVoidModalComponent } from './admin-invoice-void-modal.component';
import { AdminInvoiceContractModalComponent } from './admin-invoice-contract-modal.component';
import { AdminInvoiceReverseModalComponent } from './admin-invoice-reverse-modal.component';
import { AdminSimulatedPanelComponent } from './admin-simulated-panel.component';
import {
  adjustmentTimeline,
  auditTrailToTimeline,
  canCorrectContract,
  canRefundInvoice,
  canReversePayment,
  canVoidInvoice,
  invoiceRateLabel,
  invoiceTimeline,
  isInvoiceActionable,
  manualMethodLabel,
  mergeTimelines,
  plannedMethodLabel,
  refundMethodLabel,
  refundReasonLabel,
} from './admin-invoice-view';

export interface AdminInvoiceDrawerData {
  readonly invoiceId: string;
}

/**
 * Admin invoice drawer (#543, review S10 + S11) — replaces both the old
 * "Manage invoice" modal and the standalone invoice detail page.
 *
 * Header: invoice number, status chip, builder and a lead link. Actions
 * depend on status: unpaid (in review / failed) invoices get three
 * intent-specific buttons — Change rate · Change payment method · Record
 * payment — each opening a small modal with its before → after; a
 * disputed invoice links to its dispute. Body: amounts, an Activity
 * timeline (the dispute audit trail when there is one, otherwise the
 * invoice's own milestones), payment details and technical IDs.
 *
 * #862 (API #715): Refund… · Void… · Correct contract… · Reverse
 * payment… — each its own confirm modal with the before → after, shown
 * only for the statuses the API accepts. The Activity timeline adds the
 * invoice's refund / void / correction / reversal audit events, and the
 * Payment section lists the refund rows with the net paid.
 *
 * #791: with the simulated payment provider a dev panel (fire dispute /
 * dashboard refund / delayed failure) sits at the end of the body; it
 * never renders for the Stripe provider.
 */
@Component({
  selector: 'app-admin-invoice-drawer',
  standalone: true,
  imports: [
    RouterLink,
    UiDrawerComponent,
    UiButtonComponent,
    StatusChipComponent,
    TimelineComponent,
    KitMoneyPipe,
    KitDateTimePipe,
    AdminSimulatedPanelComponent,
  ],
  templateUrl: './admin-invoice-drawer.component.html',
  styleUrl: './admin-invoice-drawer.component.scss',
})
export class AdminInvoiceDrawerComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly modals = inject(UiModalService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly data = inject<AdminInvoiceDrawerData>(DIALOG_DATA);
  protected readonly ref = inject(UiDrawerRef);

  protected readonly detail = this.store.selectSignal(AdminInvoicesState.detail);
  protected readonly detailStatus = this.store.selectSignal(AdminInvoicesState.detailStatus);
  protected readonly detailError = this.store.selectSignal(AdminInvoicesState.detailError);
  protected readonly dispute = this.store.selectSignal(AdminInvoicesState.dispute);
  protected readonly disputeStatus = this.store.selectSignal(AdminInvoicesState.disputeStatus);
  private readonly activity = this.store.selectSignal(AdminInvoicesState.activity);

  /** `billing:manage` writes — read-only staff see the record without actions. */
  protected readonly canManageBilling = adminCan(this.store, ADMIN_PERMISSIONS.billingManage);

  /** The loaded invoice, only once it is the one this drawer opened for. */
  protected readonly invoice = computed(() => {
    const d = this.detail();
    return d !== null && d.id === this.data.invoiceId ? d : null;
  });

  protected readonly heading = computed(() => this.invoice()?.invoiceNumber ?? 'Invoice');

  /**
   * #764: subtotal / tax / total, exact to the cent (server figures).
   * Null for an untaxed invoice — the Amounts list then reads as before.
   */
  protected readonly tax = computed(() => {
    const invoice = this.invoice();
    return invoice ? formatInvoiceTax(invoice, 'Tax') : null;
  });

  /** #872: refund total + bank chargeback state; null when neither applies. */
  protected readonly recovery = computed(() => {
    const invoice = this.invoice();
    return invoice ? invoiceRecoveryState(invoice) : null;
  });

  protected readonly canAct = computed(() => {
    const invoice = this.invoice();
    return invoice !== null && this.canManageBilling() && isInvoiceActionable(invoice.status);
  });

  /**
   * #862: the adjustment actions this invoice accepts (each mirrors the
   * API's precondition). All false for read-only staff.
   */
  protected readonly adjustments = computed(() => {
    const invoice = this.invoice();
    const manage = this.canManageBilling();
    return {
      refund: manage && invoice !== null && canRefundInvoice(invoice),
      void: manage && invoice !== null && canVoidInvoice(invoice),
      correct: manage && invoice !== null && canCorrectContract(invoice),
      reverse: manage && invoice !== null && canReversePayment(invoice),
    };
  });

  protected readonly hasActions = computed(() => {
    const a = this.adjustments();
    return this.canAct() || a.refund || a.void || a.correct || a.reverse;
  });

  /**
   * #862: refund rows and the net paid (total − refunded, server figures)
   * for a paid invoice with refunds; null otherwise.
   */
  protected readonly refunds = computed(() => {
    const invoice = this.invoice();
    if (invoice === null) return null;
    const refunded = invoice.refundedCents ?? 0;
    const rows = invoice.refunds ?? [];
    if (refunded <= 0 && rows.length === 0) return null;
    return {
      state: invoice.refundState ?? 'none',
      netCents: netPaidCents(invoice),
      rows,
    };
  });

  protected readonly timeline = computed(() => {
    const invoice = this.invoice();
    if (invoice === null) return [];
    const dispute = this.dispute();
    const base =
      dispute !== null && dispute.auditTrail.length > 0
        ? auditTrailToTimeline(dispute.auditTrail)
        : invoiceTimeline(invoice);
    return mergeTimelines(base, adjustmentTimeline(this.activity()));
  });

  protected readonly rateLabel = invoiceRateLabel;
  protected readonly plannedMethodLabel = plannedMethodLabel;
  protected readonly manualMethodLabel = manualMethodLabel;
  protected readonly refundReasonLabel = refundReasonLabel;
  protected readonly refundMethodLabel = refundMethodLabel;

  ngOnInit(): void {
    this.store.dispatch(new LoadAdminInvoiceDetail(this.data.invoiceId));
    this.destroyRef.onDestroy(() => this.store.dispatch(new ClearAdminInvoiceDetail()));
  }

  protected retry(): void {
    this.store.dispatch(new LoadAdminInvoiceDetail(this.data.invoiceId));
  }

  protected changeRate(): void {
    this.openAction(AdminInvoiceRateModalComponent);
  }

  protected changeMethod(): void {
    this.openAction(AdminInvoiceMethodModalComponent);
  }

  protected recordPayment(): void {
    this.openAction(AdminInvoicePaymentModalComponent);
  }

  protected refund(): void {
    if (this.adjustments().refund) this.openModal(AdminInvoiceRefundModalComponent);
  }

  protected voidInvoice(): void {
    if (this.adjustments().void) this.openModal(AdminInvoiceVoidModalComponent);
  }

  protected correctContract(): void {
    if (this.adjustments().correct) this.openModal(AdminInvoiceContractModalComponent);
  }

  protected reversePayment(): void {
    if (this.adjustments().reverse) this.openModal(AdminInvoiceReverseModalComponent);
  }

  /** #791: a simulated event was delivered — reload the drawer and the lists behind it. */
  protected onSimulatedEvent(): void {
    this.refreshAfterChange(this.data.invoiceId);
    this.store.dispatch(new LoadBillingHealth());
  }

  private openAction<C>(component: ComponentType<C>): void {
    if (!this.canAct()) return;
    this.openModal(component);
  }

  private openModal<C>(component: ComponentType<C>): void {
    const invoice = this.invoice();
    if (invoice === null) return;
    this.modals
      .open<C, boolean, AdminInvoiceActionData>(component, {
        data: { invoice },
        size: 'sm',
        injector: this.injector,
      })
      .closed.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((changed) => {
        if (!changed) return;
        this.refreshAfterChange(invoice.id);
      });
  }

  /** Refresh the drawer and the list row behind it. */
  private refreshAfterChange(invoiceId: string): void {
    this.store.dispatch(new LoadAdminInvoiceDetail(invoiceId));
    const page = this.store.selectSnapshot(AdminInvoicesState.page);
    const pageSize = this.store.selectSnapshot(AdminInvoicesState.pageSize);
    const filters = this.store.selectSnapshot(AdminInvoicesState.filters);
    this.store.dispatch(new LoadAdminInvoices(page, pageSize, filters));
  }
}
