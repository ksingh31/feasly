import { DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, Injector, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import {
  StatusChipComponent,
  StepperComponent,
  TimelineComponent,
  UiButtonComponent,
  UiDrawerComponent,
  UiModalService,
  UiToastService,
  invoiceStepperModel,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { formatCentsToCad, formatRatePercent } from '../../shared/utils/money';
import { formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { BuilderBillingState } from './builder-billing.state';
import { injectCardModal } from './builder-card-modal.component';
import { BUILDER_COPY } from './builder-copy';
import {
  BuilderInvoiceMethodModalComponent,
  type BuilderInvoiceMethodModalData,
} from './builder-invoice-method-modal.component';
import {
  fillCopy,
  invoiceRatePercent,
  invoiceTimelineEvents,
  methodEffect,
  methodLabel,
  paymentMethodEditable,
  reviewCountdown,
} from './builder-invoice-view';
import { SelectInvoice } from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderCommissionInvoice } from './builder-invoices-api.service';
import type { BuilderPaymentMethod } from './builder-payment-methods';

export interface BuilderInvoiceDrawerData {
  readonly invoiceId: string;
}

/**
 * Builder invoice drawer (#533, builder review Should-fix 4). Opened from
 * the Invoices page with the kit Drawer (`?open=<id>`; full-height sheet on
 * phones), replacing the inline detail that swapped out the list.
 *
 * - Header: commission amount, status chip, review countdown.
 * - Lifecycle stepper (Issued → Review window → Charged → Paid).
 * - Breakdown: contract value × rate = commission — all three figures come
 *   from the server; nothing is computed here.
 * - Payment method with a single "Change" link that opens a small modal
 *   showing before/after (no inline select + Apply).
 * - Timeline from the invoice's timestamps, always sorted oldest → newest.
 * - Receipt for paid invoices; actions: question this invoice, update card.
 *
 * Reads the invoice live from BuilderInvoicesState so a saved method
 * change re-renders in place.
 */
@Component({
  selector: 'app-builder-invoice-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiDrawerComponent, UiButtonComponent, StatusChipComponent, StepperComponent, TimelineComponent],
  templateUrl: './builder-invoice-drawer.component.html',
  styleUrl: './builder-invoice-drawer.component.scss',
})
export class BuilderInvoiceDrawerComponent {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly modals = inject(UiModalService);
  private readonly toasts = inject(UiToastService);
  private readonly data = inject<BuilderInvoiceDrawerData>(DIALOG_DATA);

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly t = this.copy.invoiceDrawer;
  /** Deploy-configured "Question this invoice" destination; '' hides it. */
  protected readonly questionHref = inject(ConfigService).get('billing').questionInvoiceHref;

  private readonly selected = this.store.selectSignal(BuilderInvoicesState.selected);
  private readonly detailStatus = this.store.selectSignal(BuilderInvoicesState.detailStatus);
  private readonly card = this.store.selectSignal(BuilderBillingState.card);
  private readonly openCardModal = injectCardModal();

  /** The invoice this drawer was opened for, once loaded. */
  protected readonly invoice = computed<BuilderCommissionInvoice | null>(() => {
    const inv = this.selected();
    return inv && inv.id === this.data.invoiceId ? inv : null;
  });
  protected readonly loadFailed = computed(() => !this.invoice() && this.detailStatus() === 'error');

  protected readonly heading = computed(() => {
    const inv = this.invoice();
    return inv ? formatCentsToCad(inv.commissionCents) : this.t.loadingHeading;
  });
  protected readonly meta = computed(() => {
    const inv = this.invoice();
    return inv ? fillCopy(this.t.headerMeta, { number: inv.invoiceNumber, lead: inv.leadName }) : '';
  });
  protected readonly countdown = computed(() => {
    const inv = this.invoice();
    return inv ? reviewCountdown(inv, this.copy) : null;
  });
  protected readonly stepper = computed(() => invoiceStepperModel(this.invoice()?.status));
  protected readonly timeline = computed(() => {
    const inv = this.invoice();
    return inv ? invoiceTimelineEvents(inv, this.copy) : [];
  });

  /** Breakdown rows: server figures, formatted only. */
  protected readonly breakdown = computed(() => {
    const inv = this.invoice();
    if (!inv) return null;
    const rate = invoiceRatePercent(inv);
    const contract = formatCentsToCad(inv.contractValueCents);
    const commission = formatCentsToCad(inv.commissionCents);
    const rateText = rate === null ? '—' : formatRatePercent(rate);
    return {
      contract,
      rate: rateText,
      commission,
      formula: rate === null ? null : fillCopy(this.t.breakdownFormula, { contract, rate: rateText, commission }),
    };
  });

  protected readonly editable = computed(() => {
    const inv = this.invoice();
    return !!inv && paymentMethodEditable(inv);
  });
  protected readonly method = computed(() => {
    const inv = this.invoice();
    return inv ? methodLabel(inv.paymentMethod, this.copy, this.last4()) : '';
  });
  protected readonly methodNote = computed(() => {
    const inv = this.invoice();
    if (!inv) return null;
    return paymentMethodEditable(inv)
      ? methodEffect(inv, inv.paymentMethod, this.copy, this.last4())
      : this.copy.invoicesPaymentMethodLocked;
  });
  protected readonly changeAria = computed(() =>
    fillCopy(this.t.changeMethodAria, { number: this.invoice()?.invoiceNumber ?? '' }),
  );

  protected readonly receiptCard = computed(() => {
    const card = this.card();
    if (!card?.hasCard) return '—';
    return `${card.brand ?? ''} •••• ${card.last4 ?? ''}`.trim();
  });

  protected date(iso: string | null): string {
    return formatEdmontonMediumDate(iso);
  }

  protected retry(): void {
    this.store.dispatch(new SelectInvoice(this.data.invoiceId));
  }

  /** Failed-charge action: update the card in the shared Stripe modal (#534). */
  protected openCard(): void {
    this.openCardModal(this.card() ?? undefined);
  }

  /** "Change" → the before/after modal; a saved change shows a toast. */
  protected changeMethod(): void {
    const inv = this.invoice();
    if (!inv || !paymentMethodEditable(inv)) return;
    const ref = this.modals.open<BuilderInvoiceMethodModalComponent, BuilderPaymentMethod, BuilderInvoiceMethodModalData>(
      BuilderInvoiceMethodModalComponent,
      { data: { invoice: inv, last4: this.last4() }, size: 'sm', injector: this.injector },
    );
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((method) => {
      if (!method) return;
      this.toasts.show({
        message: fillCopy(this.t.methodChangedToast, { method: methodLabel(method, this.copy, this.last4()) }),
        tone: 'success',
      });
    });
  }

  private last4(): string | null {
    return this.card()?.last4 ?? null;
  }
}
