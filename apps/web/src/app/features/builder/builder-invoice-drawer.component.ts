import { DIALOG_DATA } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type { ConfirmInvoicePaymentResponse, SimulatedIntentResponse } from '@feasly/contracts';
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
import { formatInvoiceTax } from '../../shared/utils/invoice-tax';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { LoadBillingOverview } from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderSimulatedChallengeComponent } from './builder-simulated-challenge.component';
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
import { DownloadInvoicePdf, LoadInvoices, SelectInvoice } from './builder-invoices.actions';
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
 * - Receipt for paid invoices; actions: download PDF (#661), question
 *   this invoice, update card.
 *
 * Reads the invoice live from BuilderInvoicesState so a saved method
 * change re-renders in place.
 *
 * #791: an invoice whose charge waits on 3D Secure (`action_required`)
 * asks POST /billing/invoices/{id}/confirm-payment for its PaymentIntent.
 * With the simulated provider the drawer offers the dev-only "Complete
 * 3DS challenge" step for that PaymentIntent; the webhook settles the
 * invoice and the drawer reloads it. The Stripe on-session confirm is
 * #867 — nothing renders here for `provider: 'stripe'`.
 */
@Component({
  selector: 'app-builder-invoice-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    UiDrawerComponent,
    UiButtonComponent,
    StatusChipComponent,
    StepperComponent,
    TimelineComponent,
    BuilderSimulatedChallengeComponent,
  ],
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
  private readonly billingApi = inject(BuilderBillingApiService);

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly t = this.copy.invoiceDrawer;
  protected readonly simCopy = this.copy.simulated;
  /** Deploy-configured "Question this invoice" destination; '' hides it. */
  protected readonly questionHref = inject(ConfigService).get('billing').questionInvoiceHref;

  private readonly selected = this.store.selectSignal(BuilderInvoicesState.selected);
  private readonly detailStatus = this.store.selectSignal(BuilderInvoicesState.detailStatus);
  private readonly card = this.store.selectSignal(BuilderBillingState.card);
  private readonly openCardModal = injectCardModal();
  private readonly pdfDownloadingId = this.store.selectSignal(BuilderInvoicesState.pdfDownloadingId);
  private readonly pdfErrorId = this.store.selectSignal(BuilderInvoicesState.pdfErrorId);

  /** #661: this invoice's PDF is being fetched. */
  protected readonly pdfDownloading = computed(() => this.pdfDownloadingId() === this.data.invoiceId);
  /** #661: the last PDF download for this invoice failed. */
  protected readonly pdfFailed = computed(() => this.pdfErrorId() === this.data.invoiceId);
  protected readonly downloadAria = computed(() =>
    fillCopy(this.t.downloadPdfAria, { number: this.invoice()?.invoiceNumber ?? '' }),
  );

  /** The invoice this drawer was opened for, once loaded. */
  protected readonly invoice = computed<BuilderCommissionInvoice | null>(() => {
    const inv = this.selected();
    return inv && inv.id === this.data.invoiceId ? inv : null;
  });
  protected readonly loadFailed = computed(() => !this.invoice() && this.detailStatus() === 'error');

  /** #764: the invoice's tax breakdown; null for untaxed invoices. */
  private readonly tax = computed(() => {
    const inv = this.invoice();
    return inv ? formatInvoiceTax(inv, this.t.breakdownTaxFallback) : null;
  });

  /** The amount the builder pays: the total when taxed, else the commission. */
  protected readonly heading = computed(() => {
    const inv = this.invoice();
    if (!inv) return this.t.loadingHeading;
    return this.tax()?.total ?? formatCentsToCad(inv.commissionCents);
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
    const tax = this.tax();
    return {
      contract,
      rate: rateText,
      commission,
      // #764: subtotal / tax / total rows — hidden when the invoice carries no tax.
      tax,
      charged: tax?.total ?? commission,
      formula: rate === null ? null : fillCopy(this.t.breakdownFormula, { contract, rate: rateText, commission }),
    };
  });

  /** #791: confirm-payment lookup for an invoice waiting on 3DS. */
  protected readonly confirmStatus = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  private readonly confirmation = signal<ConfirmInvoicePaymentResponse | null>(null);
  /** #791: the 3DS step answered — hide it until the reload settles the invoice. */
  private readonly challengeDone = signal(false);

  /** #791: the simulated PaymentIntent to authenticate, or null (never for Stripe). */
  protected readonly simulatedPaymentIntentId = computed(() => {
    const c = this.confirmation();
    if (this.invoice()?.status !== 'action_required' || this.challengeDone()) return null;
    return c?.provider === 'simulated' ? c.paymentIntentId : null;
  });
  protected readonly confirmLoadFailed = computed(
    () => this.invoice()?.status === 'action_required' && this.confirmStatus() === 'error',
  );

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

  constructor() {
    // #791: look up the PaymentIntent once the invoice shows it waits on 3DS.
    effect(() => {
      const needsConfirm = this.invoice()?.status === 'action_required';
      untracked(() => {
        if (needsConfirm && this.confirmStatus() === 'idle') this.loadConfirmation();
      });
    });
  }

  /** #791: POST confirm-payment — also the retry path. */
  protected loadConfirmation(): void {
    this.confirmStatus.set('loading');
    this.billingApi
      .confirmInvoicePayment(this.data.invoiceId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (confirmation) => {
          this.confirmation.set(confirmation);
          this.confirmStatus.set('ready');
        },
        error: () => this.confirmStatus.set('error'),
      });
  }

  /** #791: the dev-only 3DS step answered; reload what the webhook settled. */
  protected onChallengeResolved(result: SimulatedIntentResponse): void {
    this.challengeDone.set(true);
    const ok = result.status === 'succeeded' || result.status === 'processing';
    this.toasts.show({
      message: ok ? this.simCopy.paymentCompletedToast : this.simCopy.paymentFailedToast,
      tone: ok ? 'success' : 'danger',
    });
    const page = this.store.selectSnapshot(BuilderInvoicesState.page);
    this.store.dispatch([new SelectInvoice(this.data.invoiceId), new LoadInvoices(page), new LoadBillingOverview()]);
  }

  protected date(iso: string | null): string {
    return formatEdmontonMediumDate(iso);
  }

  /** #661: download the server-rendered invoice/receipt PDF. */
  protected downloadPdf(): void {
    const inv = this.invoice();
    if (!inv || this.pdfDownloading()) return;
    this.store.dispatch(new DownloadInvoicePdf(inv.id, inv.invoiceNumber));
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
