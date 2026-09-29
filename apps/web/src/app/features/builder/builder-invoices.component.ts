import {
  Component,
  DestroyRef,
  OnInit,
  inject,
} from '@angular/core';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type {
  CommissionInvoice,
  CommissionInvoiceStatus,
} from '@feasly/contracts';
import { BUILDER_COPY } from './builder-copy';
import { SeoService } from '../../core/seo/seo.service';
import { formatCentsToCad } from '../../shared/utils/money';
import { BuilderBillingState } from './builder-billing.state';
import { LoadBillingCard } from './builder-billing.actions';
import {
  ClearInvoiceSelection,
  ClearInvoicesState,
  LoadInvoices,
  SelectInvoice,
} from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';

/** One row of the invoice status timeline. */
interface TimelineEntry {
  readonly label: string;
  readonly date: string;
}

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
  protected readonly card = this.store.selectSignal(BuilderBillingState.card);

  constructor() {
    this.seo.setPage({
      title: 'Invoices — Feasly builder portal',
      description: this.copy.invoicesSeoDescription,
      path: '/builder/invoices',
    });
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearInvoicesState());
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

  protected openInvoice(id: string): void {
    this.store.dispatch(new SelectInvoice(id));
  }

  protected closeDetail(): void {
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
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return date.toLocaleDateString('en-CA', {
      timeZone: 'America/Edmonton',
      dateStyle: 'medium',
    });
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
   */
  protected reviewCountdown(invoice: CommissionInvoice): string | null {
    if (invoice.status !== 'in_review' || !invoice.reviewDueAt) {
      return null;
    }
    const due = new Date(invoice.reviewDueAt);
    if (Number.isNaN(due.getTime())) {
      return null;
    }
    const dayFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const days =
      Math.round(
        (Date.parse(dayFmt.format(due)) - Date.parse(dayFmt.format(new Date()))) /
          86_400_000,
      );
    if (days < 0) {
      return null;
    }
    if (days === 0) {
      return this.copy.invoicesAutoChargeToday;
    }
    if (days === 1) {
      return this.copy.invoicesAutoChargeTomorrow;
    }
    return this.copy.invoicesAutoChargeIn.replace('{days}', String(days));
  }

  protected reviewNote(invoice: CommissionInvoice): string | null {
    if (invoice.status !== 'in_review' || !invoice.reviewDueAt) {
      return null;
    }
    return this.copy.invoicesReviewNote.replace(
      '{date}',
      this.formatEdmontonDate(invoice.reviewDueAt),
    );
  }

  protected commissionRateLabel(): string {
    return this.copy.invoicesCommissionRow.replace('{rate}', '1%');
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
