import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { filter } from 'rxjs';
import type { BuilderLeadListItem } from '@feasly/contracts';
import {
  UiButtonComponent,
  UiConfirmService,
  UiDateFieldComponent,
  UiMoneyFieldComponent,
  enumLabel,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { dateOnlyToIsoWithOffset, todayLocalDateString } from '../../shared/utils/datetime';
import {
  edmontonDayDiff,
  formatEdmontonDatePlusDays,
  formatEdmontonMediumDate,
} from '../../shared/utils/edmonton';
import { formatCentsToCad, formatRatePercent, percentOfCents } from '../../shared/utils/money';
import { BUILDER_COPY } from './builder-copy';
import { RefreshBuilderLeadsQuietly } from './builder.actions';
import { LoadBillingOverview, LoadDefaultPaymentMethod } from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';
import { ClearReportContractState, SubmitReportContract } from './builder-report-contract.actions';
import { BuilderReportContractState } from './builder-report-contract.state';
import { BuilderOnboardingState } from './builder-onboarding.state';
import { LoadBuilderAgreement } from './builder-onboarding.actions';
import { AGREEMENT_PATH, AGREEMENT_RETURN_PARAM } from './builder-agreement-gate';
import { isBuilderPaymentMethod, paymentMethodLabel } from './builder-payment-methods';
import { fill } from './builder-leads-view';

/** How the invoice will be paid, as known before it is minted. */
type ChargeKind = 'card' | 'noCard' | 'manual' | 'flat';

/**
 * Record a signed contract from the lead drawer's Won panel (#529,
 * replaces the `/builder/record-contract` page).
 *
 * MoneyField value + DateField signing date, a live commission preview at
 * the org's configured rate (from the billing overview — never a client
 * default), the expected charge date and the card on file, then the kit
 * ConfirmDialog naming amount, card and charge date before the invoice is
 * created. Success shows the minted invoice's charge date and countdown.
 *
 * The preview is display-only (`percentOfCents`); the backend computes the
 * billed amount. Submission goes through BuilderReportContractState.
 */
@Component({
  selector: 'app-builder-record-contract-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiButtonComponent, UiMoneyFieldComponent, UiDateFieldComponent],
  templateUrl: './builder-record-contract-panel.component.html',
  styleUrl: './builder-record-contract-panel.component.scss',
})
export class BuilderRecordContractPanelComponent {
  readonly lead = input.required<BuilderLeadListItem>();
  /** Emits once the contract is recorded, before the lead refresh lands. */
  readonly recorded = output<void>();

  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirms = inject(UiConfirmService);
  private readonly chargeDelayDays = inject(ConfigService).get('billing').chargeDelayDays;

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly t = this.copy.leadDrawer.record;

  protected readonly today = todayLocalDateString();
  protected readonly valueCents = signal<number | null>(null);
  protected readonly signedOn = signal<string | null>(this.today);
  /** Field errors show after the first Review attempt. */
  protected readonly attempted = signal(false);

  private readonly overview = this.store.selectSignal(BuilderBillingState.overview);
  protected readonly overviewStatus = this.store.selectSignal(BuilderBillingState.overviewStatus);
  private readonly defaultMethod = this.store.selectSignal(BuilderBillingState.defaultMethod);
  private readonly defaultMethodStatus = this.store.selectSignal(BuilderBillingState.defaultMethodStatus);

  protected readonly submitStatus = this.store.selectSignal(BuilderReportContractState.submitStatus);
  protected readonly submitError = this.store.selectSignal(BuilderReportContractState.error);
  protected readonly result = this.store.selectSignal(BuilderReportContractState.result);
  protected readonly invoice = this.store.selectSignal(BuilderReportContractState.invoice);
  /**
   * #722: no current platform-agreement acceptance → show the agreement
   * prompt instead of the form (the server refuses the call anyway).
   */
  private readonly agreementCurrent = this.store.selectSignal(BuilderOnboardingState.agreementCurrent);
  protected readonly agreementRequired = computed(() => this.agreementCurrent() === false);
  protected readonly agreementPath = AGREEMENT_PATH;
  protected readonly agreementQuery = computed(() => {
    const leadId = encodeURIComponent(this.lead().id);
    return { [AGREEMENT_RETURN_PARAM]: `/builder?open=${leadId}` };
  });
  /** Scopes the shared submit state to a submit made from this panel. */
  private readonly submittedHere = signal(false);

  protected readonly submitting = computed(() => this.submittedHere() && this.submitStatus() === 'submitting');
  protected readonly succeeded = computed(() => this.submittedHere() && this.submitStatus() === 'success');
  protected readonly failed = computed(() => this.submittedHere() && this.submitStatus() === 'error');

  protected readonly flat = computed(() => this.overview()?.planType === 'flat');
  /** The org's configured rate (percent) from the API; null until loaded or under a flat plan. */
  protected readonly ratePercent = computed(() => this.overview()?.commissionRatePercent ?? null);
  protected readonly rateLabel = computed(() => {
    const rate = this.ratePercent();
    return rate === null ? '' : formatRatePercent(rate);
  });
  protected readonly commissionLabel = computed(() => fill(this.t.commissionLabel, { rate: this.rateLabel() }));

  private readonly commissionCents = computed(() => {
    const rate = this.ratePercent();
    const value = this.valueCents();
    return rate === null || value === null || value <= 0 ? null : percentOfCents(value, rate);
  });
  protected readonly commission = computed(() => {
    const cents = this.commissionCents();
    return cents === null ? null : formatCentsToCad(cents);
  });

  protected readonly chargeKind = computed<ChargeKind>(() => {
    if (this.flat()) return 'flat';
    const method = this.defaultMethod();
    if (method && method !== 'card') return 'manual';
    return this.overview()?.card?.hasCard ? 'card' : 'noCard';
  });
  protected readonly cardLabel = computed(() => {
    const card = this.overview()?.card;
    return card?.hasCard ? fill(this.t.cardValue, { brand: enumLabel(card.brand), last4: card.last4 ?? '—' }) : '';
  });
  protected readonly methodLabel = computed(() => {
    const method = this.defaultMethod();
    return method && isBuilderPaymentMethod(method) ? paymentMethodLabel(method, this.copy).toLowerCase() : '';
  });
  protected readonly manualLine = computed(() => fill(this.t.manualMethod, { method: this.methodLabel() }));
  /** Expected charge date: today on the billing calendar + the review window. */
  protected readonly chargeDate = formatEdmontonDatePlusDays(this.chargeDelayDays);

  /**
   * Review is possible once the rate (or flat plan) AND the default payment
   * method are known — a manual-method org must never see a card-charge
   * promise because the method request was slow or failed (QA 2026-10-04).
   */
  protected readonly ready = computed(
    () =>
      this.overviewStatus() === 'ready' &&
      this.overview() !== null &&
      (this.flat() || this.defaultMethodStatus() === 'ready'),
  );
  /** Either billing read failed (the method only matters off the flat plan); retry re-dispatches both. */
  protected readonly loadFailed = computed(
    () => this.overviewStatus() === 'error' || (!this.flat() && this.defaultMethodStatus() === 'error'),
  );

  protected readonly valueError = computed(() => {
    if (!this.attempted()) return null;
    const value = this.valueCents();
    return value === null || value <= 0 ? this.t.valueRequired : null;
  });
  protected readonly dateError = computed(() => {
    if (!this.attempted()) return null;
    const date = this.signedOn();
    if (!date) return this.t.dateRequired;
    return date > this.today ? this.t.dateFuture : null;
  });

  constructor() {
    this.loadBilling();
    if (this.store.selectSnapshot(BuilderOnboardingState.agreementStatus) === 'idle') {
      this.store.dispatch(new LoadBuilderAgreement());
    }
    this.destroyRef.onDestroy(() => this.store.dispatch(new ClearReportContractState()));
  }

  protected loadBilling(): void {
    this.store
      .dispatch([new LoadBillingOverview(), new LoadDefaultPaymentMethod()])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Validates, then asks the kit ConfirmDialog before creating the invoice. */
  protected review(): void {
    this.attempted.set(true);
    const value = this.valueCents();
    const signedOn = this.signedOn();
    if (!this.ready() || this.valueError() || this.dateError() || value === null || !signedOn) return;
    const flat = this.flat();
    this.confirms
      .confirm({
        title: fill(this.t.confirmTitle, { name: this.lead().name }),
        body: this.confirmBody(value),
        verb: flat ? this.t.confirmVerbFlat : this.t.confirmVerb,
        cancelLabel: this.t.confirmCancel,
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.submit(value, signedOn));
  }

  private confirmBody(valueCents: number): string {
    const values = {
      value: formatCentsToCad(valueCents),
      commission: this.commission() ?? '',
      rate: this.rateLabel(),
      card: this.cardLabel(),
      date: this.chargeDate,
      method: this.methodLabel(),
    };
    switch (this.chargeKind()) {
      case 'flat':
        return fill(this.t.confirmBodyFlat, values);
      case 'manual':
        return fill(this.t.confirmBodyManual, values);
      case 'noCard':
        return fill(this.t.confirmBodyNoCard, values);
      case 'card':
        return fill(this.t.confirmBody, values);
    }
  }

  private submit(valueCents: number, signedOn: string): void {
    this.submittedHere.set(true);
    this.store
      .dispatch(new SubmitReportContract(this.lead().id, valueCents, dateOnlyToIsoWithOffset(signedOn)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // hasInvoice / needsRecording are server-derived: re-read quietly.
        if (this.store.selectSnapshot(BuilderReportContractState.submitStatus) === 'success') {
          this.recorded.emit();
          this.store.dispatch(new RefreshBuilderLeadsQuietly());
        }
      });
  }

  protected retry(): void {
    const value = this.valueCents();
    const signedOn = this.signedOn();
    if (value !== null && signedOn) this.submit(value, signedOn);
  }

  /** Success copy for outcomes without a fresh card-charged invoice. */
  protected readonly outcomeNote = computed<string | null>(() => {
    const outcome = this.result();
    if (!outcome) return null;
    if (outcome.billed) {
      if (outcome.reason === 'existing_invoice') return this.copy.reportContractAlreadyReported;
      if (outcome.reason === 'existing_disputed') return this.copy.reportContractDisputed;
      return null;
    }
    switch (outcome.reason) {
      case 'flat_subscription_covers':
        return this.copy.reportContractFlatCovered;
      case 'billing_not_enabled':
        return this.copy.reportContractNotEnabled;
      default:
        return this.copy.reportContractAwaitingDetails;
    }
  });

  protected readonly invoiceCommission = computed(() => {
    const inv = this.invoice();
    return inv ? formatCentsToCad(inv.commissionCents) : null;
  });

  protected readonly invoiceChargeDate = computed(() => {
    const inv = this.invoice();
    return inv?.paymentMethod === 'card' && inv.reviewDueAt ? formatEdmontonMediumDate(inv.reviewDueAt) : null;
  });

  /** Day-level countdown to the card charge on the Edmonton calendar. */
  protected readonly countdown = computed<string | null>(() => {
    const inv = this.invoice();
    if (!inv || inv.paymentMethod !== 'card' || !inv.reviewDueAt) return null;
    const days = edmontonDayDiff(inv.reviewDueAt);
    if (days === null || days < 0) return null;
    if (days === 0) return this.t.countdownToday;
    if (days === 1) return this.t.countdownTomorrow;
    return fill(this.t.countdownIn, { days: String(days) });
  });
}
