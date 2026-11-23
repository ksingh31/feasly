import { DIALOG_DATA } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer, type Subscription } from 'rxjs';
import { concatMap, take, takeWhile } from 'rxjs/operators';
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
import { invoiceRecoveryState, netPaidCents, visibleRefunds } from '../../shared/utils/invoice-recovery';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { LoadBillingOverview } from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderSimulatedChallengeComponent } from './builder-simulated-challenge.component';
import { STRIPE_LOADER, injectCardModal } from './builder-card-modal.component';
import { BUILDER_COPY } from './builder-copy';
import {
  BuilderInvoiceMethodModalComponent,
  type BuilderInvoiceMethodModalData,
} from './builder-invoice-method-modal.component';
import {
  canPayNow,
  fillCopy,
  invoiceRatePercent,
  invoiceTimelineEvents,
  methodEffect,
  methodLabel,
  nextRetryText,
  overdueBanner,
  paymentMethodEditable,
  reviewCountdown,
} from './builder-invoice-view';
import {
  DownloadInvoicePdf,
  LoadInvoices,
  PayInvoiceNow,
  RefreshSelectedInvoice,
  SelectInvoice,
} from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderCommissionInvoice } from './builder-invoices-api.service';
import type { BuilderPaymentMethod } from './builder-payment-methods';

/**
 * #867: a Stripe.js `confirmCardPayment` error that is the bank's answer
 * (decline / failed 3DS), as opposed to a transport or request error.
 */
function isBankDecline(error: { type?: string; payment_intent?: { status?: string } }): boolean {
  return error.type === 'card_error' || error.payment_intent?.status === 'requires_payment_method';
}

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
 * #791/#867: an invoice whose charge waits on 3D Secure (`action_required`)
 * shows a primary "Confirm payment with your bank" button. It asks POST
 * /billing/invoices/{id}/confirm-payment for the PaymentIntent, then
 * confirms it on-session — Stripe.js `confirmCardPayment` (via
 * STRIPE_LOADER) for `provider: 'stripe'`, the dev-only "Complete 3DS
 * challenge" step for `provider: 'simulated'`. The webhook settles the
 * invoice (`paid` / `failed`); the drawer shows "Confirming…" and
 * re-fetches it until it does. The email CTA deep-links here via
 * `/builder/invoices?open=<id>`.
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
  private readonly config = inject(ConfigService);
  private readonly loadStripe = inject(STRIPE_LOADER);
  private pollSub: Subscription | null = null;

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly t = this.copy.invoiceDrawer;
  protected readonly simCopy = this.copy.simulated;
  /** Deploy-configured "Question this invoice" destination; '' hides it. */
  protected readonly questionHref = this.config.get('billing').questionInvoiceHref;

  private readonly selected = this.store.selectSignal(BuilderInvoicesState.selected);
  private readonly detailStatus = this.store.selectSignal(BuilderInvoicesState.detailStatus);
  private readonly card = this.store.selectSignal(BuilderBillingState.card);
  private readonly openCardModal = injectCardModal();
  private readonly pdfDownloadingId = this.store.selectSignal(BuilderInvoicesState.pdfDownloadingId);
  private readonly pdfErrorId = this.store.selectSignal(BuilderInvoicesState.pdfErrorId);

  private readonly payNowId = this.store.selectSignal(BuilderInvoicesState.payNowId);
  private readonly payNowErrorId = this.store.selectSignal(BuilderInvoicesState.payNowErrorId);

  /** #901: failed card invoice — offer Pay now and show the next retry. */
  protected readonly payable = computed(() => {
    const inv = this.invoice();
    return !!inv && canPayNow(inv);
  });
  /** #901: next automatic retry date, or "None scheduled"; null when not payable. */
  protected readonly nextRetry = computed(() => {
    const inv = this.invoice();
    return inv ? nextRetryText(inv, this.copy) : null;
  });
  /** #901: the Pay now charge is in flight — the button stays disabled. */
  protected readonly paying = computed(() => this.payNowId() === this.data.invoiceId);
  /** #901: the last Pay now request for this invoice failed. */
  protected readonly payFailed = computed(() => this.payNowErrorId() === this.data.invoiceId);
  /** #901: manual-method invoice past its due date; null when not overdue. */
  protected readonly overdue = computed(() => {
    const inv = this.invoice();
    return inv ? overdueBanner(inv, this.copy) : null;
  });

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

  /**
   * #872: refund total + bank chargeback state; null when neither applies.
   * #862: plus the refund rows, the net paid and the refund-state badge.
   */
  protected readonly recovery = computed(() => {
    const inv = this.invoice();
    const state = inv ? invoiceRecoveryState(inv) : null;
    if (!inv || !state) return null;
    const refunded = state.refundedCents !== null;
    return {
      refunded: refunded ? formatCentsToCad(state.refundedCents ?? 0) : null,
      chargebackStatus: state.chargebackStatus,
      netPaid: refunded ? formatCentsToCad(netPaidCents(inv)) : null,
      rows: visibleRefunds(inv).map((r) => ({
        id: r.id,
        text: fillCopy(this.t.refundRow, {
          date: formatEdmontonMediumDate(r.createdAt),
          amount: formatCentsToCad(r.amountCents),
          reason: this.t.refundReasons[r.reason] ?? this.t.refundReasons['other'] ?? '',
        }),
        pending: r.status === 'pending',
      })),
    };
  });

  /** #862: partially refunded / refunded badge; null when nothing went back. */
  protected readonly refundState = computed(() => {
    const state = this.invoice()?.refundState;
    return state === 'partially_refunded' || state === 'refunded' ? state : null;
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

  /**
   * #791/#867 bank-confirmation step for an invoice in `action_required`:
   * - `idle`: the primary "Confirm payment with your bank" button.
   * - `starting`: POST confirm-payment (and, for Stripe, the 3DS confirm) in flight.
   * - `challenge`: simulated provider — the dev-only 3DS step.
   * - `pending`: the bank answered; re-fetching until the webhook settles it.
   * - `stalled`: still waiting after the poll window — "Check again".
   * - `error`: confirm-payment or Stripe.js failed — retry offered.
   */
  protected readonly confirmPhase = signal<'idle' | 'starting' | 'challenge' | 'pending' | 'stalled' | 'error'>(
    'idle',
  );
  /** #791: the simulated PaymentIntent waiting on the dev-only 3DS step. */
  private readonly challengeIntentId = signal<string | null>(null);

  /** The invoice waits on the builder's bank (3D Secure). */
  protected readonly needsConfirm = computed(() => this.invoice()?.status === 'action_required');
  /** #791: the simulated PaymentIntent to authenticate, or null (never for Stripe). */
  protected readonly simulatedPaymentIntentId = computed(() =>
    this.needsConfirm() && this.confirmPhase() === 'challenge' ? this.challengeIntentId() : null,
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

  /**
   * #867: "Confirm payment with your bank" — asks POST confirm-payment for
   * the PaymentIntent, then confirms it on-session: Stripe.js
   * `confirmCardPayment` for `provider: 'stripe'`, the dev-only 3DS step for
   * `provider: 'simulated'`. Never marks the invoice paid — the webhook
   * settles it and the drawer re-fetches. Also the retry path.
   */
  protected startConfirm(): void {
    if (this.confirmPhase() === 'starting') return;
    this.confirmPhase.set('starting');
    this.billingApi
      .confirmInvoicePayment(this.data.invoiceId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (confirmation) => {
          if (confirmation.provider === 'simulated') {
            this.challengeIntentId.set(confirmation.paymentIntentId);
            this.confirmPhase.set('challenge');
            return;
          }
          void this.confirmWithStripe(confirmation);
        },
        error: () => this.confirmPhase.set('error'),
      });
  }

  private async confirmWithStripe(confirmation: ConfirmInvoicePaymentResponse): Promise<void> {
    const key = this.config.get('billing').stripePublishableKey;
    try {
      const stripe = key ? await this.loadStripe(key) : null;
      if (!stripe) {
        this.confirmPhase.set('error');
        return;
      }
      const result = await stripe.confirmCardPayment(
        confirmation.clientSecret,
        confirmation.paymentMethodId ? { payment_method: confirmation.paymentMethodId } : undefined,
      );
      if (!result.error) {
        this.bankAnswered(true);
        return;
      }
      // Only a real bank answer (a decline / failed or abandoned 3DS check —
      // `card_error`, or the PaymentIntent back in `requires_payment_method`)
      // fails the PaymentIntent; the webhook moves the invoice to `failed`.
      // Anything else (network, rate limit, invalid request) leaves it in
      // `requires_action` with no webhook coming — offer the retry instead.
      if (isBankDecline(result.error)) {
        this.bankAnswered(false);
      } else {
        this.confirmPhase.set('error');
      }
    } catch {
      this.confirmPhase.set('error');
    }
  }

  /** #791: the dev-only 3DS step answered; reload what the webhook settled. */
  protected onChallengeResolved(result: SimulatedIntentResponse): void {
    this.bankAnswered(result.status === 'succeeded' || result.status === 'processing');
  }

  /** The bank answered: toast, refresh the slices, and poll until the webhook settles. */
  private bankAnswered(ok: boolean): void {
    this.toasts.show({
      message: ok ? this.simCopy.paymentCompletedToast : this.simCopy.paymentFailedToast,
      tone: ok ? 'success' : 'danger',
    });
    const page = this.store.selectSnapshot(BuilderInvoicesState.page);
    this.store.dispatch([
      new RefreshSelectedInvoice(this.data.invoiceId),
      new LoadInvoices(page),
      new LoadBillingOverview(),
    ]);
    this.pollUntilSettled();
  }

  /** #867: "Check again" after the poll window, and the first poll round. */
  protected pollUntilSettled(): void {
    this.pollSub?.unsubscribe();
    this.confirmPhase.set('pending');
    const { confirmPollIntervalMs: every, confirmPollAttempts: attempts } = this.config.get('billing');
    this.pollSub = timer(every, every)
      .pipe(
        take(attempts),
        // Wait for each refresh to land before the next tick / completion, so
        // the final poll's answer is in the store when `complete` decides.
        concatMap(() => this.store.dispatch(new RefreshSelectedInvoice(this.data.invoiceId))),
        takeWhile(() => this.needsConfirm()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        complete: () => {
          if (this.needsConfirm()) {
            this.confirmPhase.set('stalled');
          } else {
            this.store.dispatch([
              new LoadInvoices(this.store.selectSnapshot(BuilderInvoicesState.page)),
              new LoadBillingOverview(),
            ]);
          }
        },
      });
  }

  /**
   * #901 Pay now: charge the card on file right away. Disabled while in
   * flight (and the state + API both ignore a double submit). The result
   * decides the toast; an `action_required` answer leaves the drawer on
   * the bank-confirmation step. The list and billing overview reload so
   * every surface shows the new status.
   */
  protected payNow(): void {
    const inv = this.invoice();
    if (!inv || !canPayNow(inv) || this.paying() || this.payNowId() !== null) return;
    this.store
      .dispatch(new PayInvoiceNow(inv.id))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.payFailed()) return;
        const status = this.invoice()?.status;
        if (status === 'paid' || status === 'finalized') {
          this.toasts.show({ message: this.t.payNowPaidToast, tone: 'success' });
        } else if (status === 'action_required') {
          this.toasts.show({ message: this.t.payNowConfirmToast });
        } else if (status === 'failed') {
          this.toasts.show({ message: this.t.payNowDeclinedToast, tone: 'danger' });
        }
        this.store.dispatch([
          new LoadInvoices(this.store.selectSnapshot(BuilderInvoicesState.page)),
          new LoadBillingOverview(),
        ]);
      });
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
