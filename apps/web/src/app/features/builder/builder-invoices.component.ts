import {
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type {
  CommissionInvoice,
  CommissionInvoiceStatus,
} from '@feasly/contracts';
import { firstValueFrom, Subject, timer } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { BUILDER_COPY } from './builder-copy';
import { SeoService } from '../../core/seo/seo.service';
import { formatCentsToCad, formatRatePercent } from '../../shared/utils/money';
import {
  edmontonDayDiff,
  formatEdmontonMediumDate,
} from '../../shared/utils/edmonton';
import { BuilderBillingState } from './builder-billing.state';
import { LoadBillingCard } from './builder-billing.actions';
import {
  BUILDER_PAYMENT_METHODS,
  isBuilderPaymentMethod,
  paymentMethodLabel,
  type BuilderPaymentMethod,
} from './builder-payment-methods';
import {
  ClearInvoiceSelection,
  ClearInvoicesState,
  LoadInvoices,
  SelectInvoice,
  SetInvoiceNumberFilter,
  UpdateInvoicePaymentMethod,
} from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderCommissionInvoice } from './builder-invoices-api.service';

/** One row of the invoice status timeline. */
interface TimelineEntry {
  readonly label: string;
  readonly date: string;
}

/**
 * Invoice-number search debounce (UI-responsiveness timing, not a tunable:
 * balances per-keystroke API calls against search snappiness; changes with
 * the UX, not by deploy tuning). See the hardcode allowlist.
 */
const INVOICE_NUMBER_FILTER_DEBOUNCE_MS = 400;

/**
 * Builder invoices page (BILL-04): `/builder/invoices`.
 *
 * Paginated, tenant-scoped commission invoice list (newest first) plus a
 * detail view per invoice: line items, status timeline, charge-state
 * banners, and a receipt for paid invoices. All state lives in
 * BuilderInvoicesState; the component dispatches and renders selectors.
 *
 * Charge surfaces: a failed invoice renders the "card declined" banner
 * with an "Update your card" CTA back to the BILL-02 card form; a paid
 * invoice renders receipt details (amount, charge date, card last4 from
 * the card-on-file state).
 *
 * No dispute affordance — builder disputes are deferred (Karan 2026-09-27)
 * and stay in the admin console.
 */
@Component({
  selector: 'app-builder-invoices',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './builder-invoices.component.html',
  styleUrls: ['./builder-invoices.component.scss'],
})
export class BuilderInvoicesComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  protected readonly invoices = this.store.selectSignal(
    BuilderInvoicesState.invoices,
  );
  protected readonly total = this.store.selectSignal(BuilderInvoicesState.total);
  protected readonly page = this.store.selectSignal(BuilderInvoicesState.page);
  protected readonly pageSize = this.store.selectSignal(
    BuilderInvoicesState.pageSize,
  );
  protected readonly totalPages = this.store.selectSignal(
    BuilderInvoicesState.totalPages,
  );
  protected readonly listStatus = this.store.selectSignal(
    BuilderInvoicesState.listStatus,
  );
  protected readonly selected = this.store.selectSignal(
    BuilderInvoicesState.selected,
  );
  protected readonly detailStatus = this.store.selectSignal(
    BuilderInvoicesState.detailStatus,
  );
  protected readonly paymentMethodSaveStatus = this.store.selectSignal(
    BuilderInvoicesState.paymentMethodSaveStatus,
  );
  protected readonly card = this.store.selectSignal(BuilderBillingState.card);

  /**
   * Staged (not yet applied) payment method for the open detail view.
   * The select only stages a choice — nothing is saved until the builder
   * clicks Apply (Karan 2026-10-02: no auto-save on select). `null` means
   * no pending change; the select then shows the saved method. Cleared
   * whenever the detail view opens/closes so a staged choice never leaks
   * into another invoice.
   */
  protected readonly pendingPaymentMethod =
    signal<BuilderPaymentMethod | null>(null);

  /**
   * Transient "saved" confirmation after a successful Apply. Cleared on
   * the next selection, Apply, or detail-view change.
   */
  protected readonly paymentMethodSavedFlash = signal(false);

  /** How long the "Payment method updated." confirmation stays visible. */
  private static readonly PAYMENT_METHOD_SAVED_FLASH_MS = 4000;

  /**
   * Invoice-number search box text (what the user typed). The committed
   * server-side filter lives in the state; typing debounces into
   * {@link SetInvoiceNumberFilter} so the list searches as you type.
   */
  protected readonly filterText = signal('');

  /** Raw keystrokes → debounced filter dispatch (no leaked subscription). */
  private readonly filterInput$ = new Subject<string>();

  constructor() {
    this.seo.setPage({
      title: 'Invoices — Feasly builder portal',
      description: this.copy.invoicesSeoDescription,
      path: '/builder/invoices',
    });
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearInvoicesState());
    });
    this.filterInput$
      .pipe(
        debounceTime(INVOICE_NUMBER_FILTER_DEBOUNCE_MS),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((value) => {
        this.store.dispatch(new SetInvoiceNumberFilter(value));
      });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadInvoices(1));
    // Card summary for paid-invoice receipts (last4 display).
    this.store.dispatch(new LoadBillingCard());
    // Deep link from the record-contract success card: ?invoice=<id>
    // opens the invoice detail directly. The detail fetch is independent
    // of the list, so no need to wait for the list to load.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const invoiceId = params.get('invoice');
        if (invoiceId) {
          this.store.dispatch(new SelectInvoice(invoiceId));
        }
      });
  }

  protected retryLoad(): void {
    this.store.dispatch(new LoadInvoices(this.page()));
  }

  /** Keystroke in the invoice-number search box — debounced into the state. */
  protected onFilterInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.filterText.set(value);
    this.filterInput$.next(value);
  }

  /** Clears the invoice-number search and reloads the full list. */
  protected clearFilter(): void {
    this.filterText.set('');
    this.store.dispatch(new SetInvoiceNumberFilter(''));
  }

  protected openInvoice(id: string): void {
    this.pendingPaymentMethod.set(null);
    this.paymentMethodSavedFlash.set(false);
    this.store.dispatch(new SelectInvoice(id));
  }

  protected closeDetail(): void {
    this.pendingPaymentMethod.set(null);
    this.paymentMethodSavedFlash.set(false);
    this.store.dispatch(new ClearInvoiceSelection());
    // Drop the deep-link param so a closed detail doesn't reopen on the
    // next visit within this session.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {},
    });
  }

  protected prevPage(): void {
    this.store.dispatch(new LoadInvoices(this.page() - 1));
  }

  protected nextPage(): void {
    this.store.dispatch(new LoadInvoices(this.page() + 1));
  }

  protected pageLabel(): string {
    const totalPages = this.totalPages();
    if (totalPages === null) {
      // Backend reports no total (bare-array pagination): "Page N".
      return this.copy.invoicesPage.replace('{page}', String(this.page()));
    }
    return this.copy.invoicesPageOf
      .replace('{page}', String(this.page()))
      .replace('{pages}', String(totalPages));
  }

  /**
   * Whether the Next button should be disabled. With a known total this is
   * the last numbered page; with an unknown total (bare-array backend) the
   * page is last when it came back shorter than a full page.
   */
  protected isLastPage(): boolean {
    const totalPages = this.totalPages();
    if (totalPages !== null) {
      return this.page() >= totalPages;
    }
    return this.invoices().length < this.pageSize();
  }

  /** Integer cents → "$12,345" (shared money util, integer math only). */
  protected money(cents: number): string {
    return formatCentsToCad(cents);
  }

  /** ISO instant → America/Edmonton medium date (the billing calendar). */
  protected formatEdmontonDate(iso: string | null): string {
    return formatEdmontonMediumDate(iso);
  }

  protected statusLabel(status: CommissionInvoiceStatus): string {
    switch (status) {
      case 'draft':
        return this.copy.invoiceStatusDraft;
      case 'in_review':
        return this.copy.invoiceStatusInReview;
      case 'finalized':
        return this.copy.invoiceStatusFinalized;
      case 'paid':
        return this.copy.invoiceStatusPaid;
      case 'failed':
        return this.copy.invoiceStatusFailed;
      case 'disputed':
        return this.copy.invoiceStatusDisputed;
      case 'void':
        return this.copy.invoiceStatusVoid;
    }
  }

  /**
   * Day-level review-deadline countdown on the America/Edmonton calendar.
   * Returns null when the invoice is not in review or has no deadline.
   * Method-aware (Karan 2026-10-02): "Auto-charges" only for card on file —
   * manual methods (cheque, e-transfer, bank draft) never auto-charge, so
   * they get a plain "Due in X days".
   */
  protected reviewCountdown(invoice: CommissionInvoice): string | null {
    if (invoice.status !== 'in_review' || !invoice.reviewDueAt) {
      return null;
    }
    const days = edmontonDayDiff(invoice.reviewDueAt);
    if (days === null || days < 0) {
      return null;
    }
    const autoCharge = invoice.paymentMethod === 'card';
    if (days === 0) {
      return autoCharge ? this.copy.invoicesAutoChargeToday : this.copy.invoicesDueToday;
    }
    if (days === 1) {
      return autoCharge
        ? this.copy.invoicesAutoChargeTomorrow
        : this.copy.invoicesDueTomorrow;
    }
    const template = autoCharge ? this.copy.invoicesAutoChargeIn : this.copy.invoicesDueIn;
    return template.replace('{days}', String(days));
  }

  protected reviewNote(invoice: BuilderCommissionInvoice): string | null {
    if (invoice.status !== 'in_review' || !invoice.reviewDueAt) {
      return null;
    }
    const date = this.formatEdmontonDate(invoice.reviewDueAt);
    if (invoice.paymentMethod === 'card') {
      return this.copy.invoicesReviewNote.replace('{date}', date);
    }
    // Manual method: the card will not be charged — say so plainly.
    return this.copy.invoicesReviewNoteManual
      .replace('{date}', date)
      .replace('{method}', this.methodLabel(invoice.paymentMethod).toLowerCase());
  }

  /** Payment-method options in display order (billing/12). */
  protected paymentMethodOptions(): readonly BuilderPaymentMethod[] {
    return BUILDER_PAYMENT_METHODS;
  }

  /**
   * The method can be changed until the invoice is settled: paid, void,
   * and disputed invoices are locked with an explainer.
   */
  protected paymentMethodEditable(invoice: BuilderCommissionInvoice): boolean {
    return (
      invoice.status !== 'paid' &&
      invoice.status !== 'void' &&
      invoice.status !== 'disputed'
    );
  }

  /** Buyer-grade label, e.g. "Card •••• 4242" or "Cheque". */
  protected methodLabel(method: BuilderPaymentMethod): string {
    return paymentMethodLabel(method, this.copy, this.card()?.last4);
  }

  /**
   * The method the select shows: the staged choice while one is pending,
   * otherwise the saved method. The review note and manual-method
   * explainer always read the SAVED method (`invoice.paymentMethod`) —
   * never the staged one — so the messaging always describes what the
   * backend will actually do.
   */
  protected displayedPaymentMethod(
    invoice: BuilderCommissionInvoice,
  ): BuilderPaymentMethod {
    return this.pendingPaymentMethod() ?? invoice.paymentMethod;
  }

  /** Apply is only meaningful when a real change is staged. */
  protected canApplyPaymentMethod(invoice: BuilderCommissionInvoice): boolean {
    const pending = this.pendingPaymentMethod();
    return (
      pending !== null &&
      pending !== invoice.paymentMethod &&
      this.paymentMethodEditable(invoice)
    );
  }

  /**
   * Stages the dropdown choice without saving (billing/12 rework,
   * Karan 2026-10-02: changing the method must not apply on select).
   * Re-selecting the saved method clears the staged change.
   */
  protected onInvoicePaymentMethodSelect(
    invoice: BuilderCommissionInvoice,
    event: Event,
  ): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isBuilderPaymentMethod(value) || !this.paymentMethodEditable(invoice)) {
      return;
    }
    this.paymentMethodSavedFlash.set(false);
    this.pendingPaymentMethod.set(
      value === invoice.paymentMethod ? null : value,
    );
  }

  /** Discards the staged choice; the select snaps back to the saved method. */
  protected resetPendingPaymentMethod(): void {
    this.pendingPaymentMethod.set(null);
  }

  /**
   * Applies the staged payment method (billing/12). Disabled until the
   * staged choice differs from the saved method. On success the saved
   * method (and the method-aware review note) updates and a transient
   * confirmation shows; on failure the select reverts to the saved value
   * and the save-failed copy surfaces under the control.
   */
  protected async applyInvoicePaymentMethod(
    invoice: BuilderCommissionInvoice,
  ): Promise<void> {
    const pending = this.pendingPaymentMethod();
    if (
      pending === null ||
      pending === invoice.paymentMethod ||
      !this.paymentMethodEditable(invoice)
    ) {
      return;
    }
    this.paymentMethodSavedFlash.set(false);
    await firstValueFrom(
      this.store.dispatch(new UpdateInvoicePaymentMethod(invoice.id, pending)),
    );
    // The staged choice is consumed either way: on success the select
    // shows the new saved method; on failure it reverts to the old one.
    this.pendingPaymentMethod.set(null);
    if (
      this.store.selectSnapshot(
        BuilderInvoicesState.paymentMethodSaveStatus,
      ) === 'idle'
    ) {
      this.paymentMethodSavedFlash.set(true);
      timer(BuilderInvoicesComponent.PAYMENT_METHOD_SAVED_FLASH_MS)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.paymentMethodSavedFlash.set(false));
    }
  }

  /**
   * Explainer under the method control for manual methods outside the
   * review window (in-review invoices get the review-note variant).
   */
  protected manualMethodNote(invoice: BuilderCommissionInvoice): string | null {
    if (invoice.paymentMethod === 'card' || invoice.status === 'in_review') {
      return null;
    }
    return this.copy.invoicesPaymentMethodManualNote.replace(
      '{method}',
      this.methodLabel(invoice.paymentMethod).toLowerCase(),
    );
  }

  /**
   * Per-invoice commission row label, e.g. "Commission (1%)" — the
   * invoice's effective rate (override → snapshot → config default),
   * computed server-side. Falls back to 1% when the field is absent.
   */
  protected commissionRateLabel(invoice: CommissionInvoice): string {
    return this.copy.invoicesCommissionRow.replace(
      '{rate}',
      formatRatePercent(invoice.effectiveRatePercent ?? 1),
    );
  }

  /** Card summary for receipts: "Visa •••• 4242". */
  protected receiptCardLabel(): string {
    const card = this.card();
    if (!card?.hasCard) {
      return '—';
    }
    return `${card.brand ?? ''} •••• ${card.last4 ?? ''}`.trim();
  }

  /** Status timeline for the detail view (no dispute affordance). */
  protected timeline(invoice: CommissionInvoice): TimelineEntry[] {
    const entries: TimelineEntry[] = [
      { label: this.copy.invoicesTimelineCreated, date: invoice.createdAt },
    ];
    if (invoice.reviewDueAt) {
      entries.push({
        label: this.copy.invoicesTimelineReviewEnds,
        date: invoice.reviewDueAt,
      });
    }
    if (invoice.finalizedAt) {
      entries.push({
        label: this.copy.invoicesTimelineFinalized,
        date: invoice.finalizedAt,
      });
    }
    if (invoice.paidAt) {
      entries.push({
        label: this.copy.invoicesTimelinePaid,
        date: invoice.paidAt,
      });
    } else if (invoice.status === 'failed') {
      entries.push({
        label: this.copy.invoicesTimelineFailed,
        date: invoice.updatedAt,
      });
    }
    return entries;
  }
}
