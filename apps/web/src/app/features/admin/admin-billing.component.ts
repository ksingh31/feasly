import { Component, DestroyRef, Injector, OnInit, computed, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { filter, switchMap } from 'rxjs';
import type { BillingHealthDunningInvoice, BillingHealthInReviewInvoice } from '@feasly/contracts';
import {
  type DataTableColumn,
  DataTableComponent,
  ErrorStateComponent,
  KitDateTimePipe,
  KitMoneyPipe,
  KpiGridComponent,
  KpiTileComponent,
  PageHeaderComponent,
  SkeletonComponent,
  StatusChipComponent,
  UiButtonComponent,
  UiConfirmService,
  UiDrawerService,
  UiModalService,
  type UiRowAction,
  UiRowActionsComponent,
  UiRowActionsDirective,
  UiToastService,
  injectDrawerParam,
} from '@app/shared/ui';
import { LoadBillingHealth, RetryInvoiceCharge } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';
import { AdminBuildersState } from './admin-builders.state';
import { LoadBuilders } from './admin-builders.actions';
import { AdminCreateInvoiceComponent } from './admin-create-invoice.component';
import { AdminInvoiceDrawerComponent, type AdminInvoiceDrawerData } from './admin-invoice-drawer.component';
import { AdminInvoicePaymentModalComponent } from './admin-invoice-payment-modal.component';
import type { AdminInvoiceActionData } from './admin-invoice-action-modal';
import { ClearAdminInvoiceDetail, LoadAdminInvoiceDetail } from './admin-invoices.actions';
import { AdminInvoicesState } from './admin-invoices.state';
import { plannedMethodLabel } from './admin-invoice-view';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import {
  builderNameFor,
  daysOverdue,
  ratePercentLabel,
  retriesExhausted,
  retryConfirmOptions,
  retryLabel,
  stripeModeKey,
} from './admin-billing-view';

/**
 * Admin Billing overview (#544, review S9) — `/admin/billing`.
 *
 * PageHeader with [Create invoice] (opens a modal with builder + lead
 * pickers) and [Refresh]; the billing model and Stripe mode sit in the
 * header as non-interactive StatusChips. KPI tiles (MRR, collected 30d,
 * disputed, in-review aging), then two kit DataTables — In review and
 * Dunning — whose rows open the invoice drawer in place (`?open=<id>`).
 * Each row has one "Manage" button plus an overflow: Record payment, and
 * (dunning) Retry charge. Every money action confirms with the amount and
 * the builder. Webhook health lives on its own page (#547); a diagnostics
 * link points there.
 *
 * Write actions render only with `billing:manage` (the backend 403s
 * without it). noindex,nofollow via the robots guard; not prerendered.
 */
@Component({
  selector: 'app-admin-billing',
  standalone: true,
  imports: [
    RouterLink,
    PageHeaderComponent,
    StatusChipComponent,
    UiButtonComponent,
    KpiGridComponent,
    KpiTileComponent,
    DataTableComponent,
    UiRowActionsDirective,
    UiRowActionsComponent,
    ErrorStateComponent,
    SkeletonComponent,
    KitDateTimePipe,
    KitMoneyPipe,
  ],
  templateUrl: './admin-billing.component.html',
  styleUrl: './admin-billing.component.scss',
})
export class AdminBillingComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly drawers = inject(UiDrawerService);
  private readonly modals = inject(UiModalService);
  private readonly confirms = inject(UiConfirmService);
  private readonly toasts = inject(UiToastService);

  protected readonly health = this.store.selectSignal(BillingHealthState.health);
  protected readonly loadStatus = this.store.selectSignal(BillingHealthState.loadStatus);
  protected readonly error = this.store.selectSignal(BillingHealthState.error);
  protected readonly hasWebhookIssues = this.store.selectSignal(BillingHealthState.hasWebhookIssues);
  /** Invoice id currently retrying its charge, or null. BILL-03. */
  protected readonly retryingInvoiceId = this.store.selectSignal(BillingHealthState.retryingInvoiceId);
  private readonly builders = this.store.selectSignal(AdminBuildersState.builders);

  /** `billing:manage` — read-only staff see the overview without actions. */
  protected readonly canManageBilling = adminCan(this.store, ADMIN_PERMISSIONS.billingManage);

  /** `?open=<id>` — the invoice whose drawer is open. */
  protected readonly openId = injectDrawerParam();

  protected readonly stripeMode = computed(() => {
    const h = this.health();
    return h ? stripeModeKey(h.stripe) : null;
  });

  protected readonly inReviewRows = computed(() => this.health()?.inReviewInvoices ?? []);
  protected readonly dunningRows = computed(() => this.health()?.dunning ?? []);
  protected readonly maxRetries = computed(() => this.health()?.maxChargeRetries);

  protected readonly inReviewId = (row: BillingHealthInReviewInvoice): string => row.id;
  protected readonly dunningId = (row: BillingHealthDunningInvoice): string => row.id;

  protected readonly inReviewColumns: readonly DataTableColumn<BillingHealthInReviewInvoice>[] = [
    { key: 'builder', header: 'Builder', cardRole: 'title', value: (r) => this.builderName(r.tenantKey) },
    { key: 'commissionCents', header: 'Amount', kind: 'money', cardRole: 'meta' },
    { key: 'rate', header: 'Rate', cardRole: 'hidden', value: (r) => ratePercentLabel(r.commissionRatePercent) },
    { key: 'reviewDueAt', header: 'Review due', kind: 'date', cardRole: 'meta' },
    { key: 'method', header: 'Paid by', cardRole: 'meta', value: (r) => plannedMethodLabel(r.paymentMethod) },
  ];

  protected readonly dunningColumns: readonly DataTableColumn<BillingHealthDunningInvoice>[] = [
    { key: 'builder', header: 'Builder', cardRole: 'title', value: (r) => this.builderName(r.tenantKey) },
    { key: 'commissionCents', header: 'Amount', kind: 'money', cardRole: 'meta' },
    { key: 'pastDueSince', header: 'Past due since', kind: 'date', cardRole: 'hidden' },
    { key: 'daysOverdue', header: 'Days overdue', kind: 'count', cardRole: 'meta', value: (r) => daysOverdue(r.pastDueSince) },
    {
      key: 'retries',
      header: 'Retries',
      cardRole: 'meta',
      value: (r) => `${r.retryCount} of ${this.maxRetries() ?? '—'}`,
    },
    { key: 'lastFailureReason', header: 'Last failure', cardRole: 'hidden' },
  ];

  constructor() {
    // Deep links and Back/Forward drive the drawer off the URL.
    effect(() => {
      const id = this.openId();
      untracked(() => {
        if (id !== null && this.drawers.openDrawer?.urlId !== id) this.openInvoice(id);
      });
    });
  }

  ngOnInit(): void {
    this.refresh();
    if (this.store.selectSnapshot(AdminBuildersState.listStatus) === 'idle') {
      this.store.dispatch(new LoadBuilders());
    }
  }

  protected refresh(): void {
    this.store.dispatch(new LoadBillingHealth());
  }

  protected builderName(tenantKey: string): string {
    return builderNameFor(this.builders(), tenantKey);
  }

  protected plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
  }

  // ---- Create invoice -------------------------------------------------

  protected openCreateInvoice(): void {
    if (!this.canManageBilling()) return;
    this.modals.open<AdminCreateInvoiceComponent, boolean>(AdminCreateInvoiceComponent, {
      size: 'md',
      injector: this.injector,
    });
  }

  // ---- Row actions ----------------------------------------------------

  protected openInvoice(invoiceId: string): void {
    this.drawers.open<AdminInvoiceDrawerComponent, void, AdminInvoiceDrawerData>(AdminInvoiceDrawerComponent, {
      data: { invoiceId },
      size: 'lg',
      urlId: invoiceId,
      injector: this.injector,
    });
  }

  protected inReviewActions(): readonly UiRowAction[] {
    return this.canManageBilling() ? [{ id: 'record-payment', label: 'Record payment…' }] : [];
  }

  protected dunningActions(row: BillingHealthDunningInvoice): readonly UiRowAction[] {
    if (!this.canManageBilling()) return [];
    const exhausted = retriesExhausted(row.retryCount, this.maxRetries());
    return [
      {
        id: 'retry',
        label: `${retryLabel(row.retryCount, this.maxRetries())}…`,
        disabled: exhausted || this.retryingInvoiceId() === row.id,
        hint: exhausted ? 'All retries used. Record the payment or contact the builder.' : undefined,
      },
      { id: 'record-payment', label: 'Record payment…' },
    ];
  }

  protected onRowAction(invoiceId: string, action: string): void {
    if (action === 'record-payment') {
      this.recordPayment(invoiceId);
      return;
    }
    if (action === 'retry') {
      const row = this.dunningRows().find((r) => r.id === invoiceId);
      if (row) this.retryCharge(row);
    }
  }

  /** BILL-03 retry: always through ConfirmDialog naming the amount + builder. */
  protected retryCharge(row: BillingHealthDunningInvoice): void {
    const maxRetries = this.maxRetries();
    if (!this.canManageBilling() || retriesExhausted(row.retryCount, maxRetries)) return;
    this.confirms
      .confirm(
        retryConfirmOptions({
          builderName: this.builderName(row.tenantKey),
          commissionCents: row.commissionCents,
          retryCount: row.retryCount,
          maxRetries,
        }),
      )
      .pipe(
        filter(Boolean),
        switchMap(() => this.store.dispatch(new RetryInvoiceCharge(row.id))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        const feedback = this.store.selectSnapshot(BillingHealthState.retryFeedback);
        if (feedback) this.toasts.show({ message: feedback.message, tone: feedback.ok ? 'success' : 'danger' });
      });
  }

  /**
   * Record payment from the queue: loads the invoice, then opens the same
   * focused modal the drawer uses (builder, amount, before → after).
   */
  protected recordPayment(invoiceId: string): void {
    if (!this.canManageBilling()) return;
    this.store
      .dispatch(new LoadAdminInvoiceDetail(invoiceId))
      .pipe(
        switchMap(() => {
          const invoice = this.store.selectSnapshot(AdminInvoicesState.detail);
          if (invoice === null || invoice.id !== invoiceId) {
            this.toasts.show({ message: 'Couldn’t load that invoice. Try again.', tone: 'danger' });
            return [];
          }
          return this.modals.open<AdminInvoicePaymentModalComponent, boolean, AdminInvoiceActionData>(
            AdminInvoicePaymentModalComponent,
            { data: { invoice }, size: 'sm', injector: this.injector },
          ).closed;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        complete: () => {
          if (this.drawers.openDrawer === null) this.store.dispatch(new ClearAdminInvoiceDetail());
        },
      });
  }
}
