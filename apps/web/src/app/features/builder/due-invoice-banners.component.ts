import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { CommissionInvoice } from '@feasly/contracts';
import { BUILDER_COPY } from './builder-copy';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderInvoicesState } from './builder-invoices.state';
import {
  DismissAllBanners,
  DismissBanner,
  SetBannersCollapsed,
  ToggleBannerOpen,
} from './due-invoice-banners.actions';
import { DueInvoiceBannersState } from './due-invoice-banners.state';
import {
  edmontonDayDiff,
  formatEdmontonMediumDate,
} from '../../shared/utils/edmonton';
import { formatCentsToCad } from '../../shared/utils/money';

/** Why a due invoice gets a banner. */
export type DueReason = 'failed' | 'due-today' | 'overdue';

/**
 * Banner reason for an invoice, or null when it needs no banner: a failed
 * charge always qualifies; an in-review invoice qualifies when its
 * America/Edmonton review deadline is today or past. Pure function of
 * invoice state — exported for unit tests.
 */
export function dueReasonFor(invoice: CommissionInvoice): DueReason | null {
  if (invoice.status === 'failed') {
    return 'failed';
  }
  if (invoice.status === 'in_review' && invoice.reviewDueAt) {
    const days = edmontonDayDiff(invoice.reviewDueAt);
    if (days !== null && days <= 0) {
      return days === 0 ? 'due-today' : 'overdue';
    }
  }
  return null;
}

/**
 * Due-invoice notification banners for the builder dashboard.
 *
 * One gold banner per invoice that needs attention (failed charge, or
 * review window ended on the Edmonton calendar). Each banner expands to
 * invoice details with a link to the invoice; × dismisses (persisted via
 * NGXS + storage plugin — a refresh keeps it dismissed). Collapse-all
 * folds the stack into one slim summary bar so a long list never takes
 * over the page. Banners are purely data-driven: when an invoice leaves
 * the actionable set (paid, voided, …) its banner is gone with no user
 * action, and its dismissal id is pruned.
 *
 * Invoice data comes from BuilderInvoicesState.actionableInvoices (the
 * dashboard route lazy-provides it and dispatches LoadActionableInvoices
 * on init — EVERY actionable invoice, not just the first page); the card
 * summary for the payment-method line comes from the root
 * BuilderBillingState. Banner UI state (dismissed/open/collapsed) lives
 * in DueInvoiceBannersState.
 */
@Component({
  selector: 'app-due-invoice-banners',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './due-invoice-banners.component.html',
  styleUrls: ['./due-invoice-banners.component.scss'],
})
export class DueInvoiceBannersComponent {
  private readonly store = inject(Store);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  private readonly invoices = this.store.selectSignal(
    BuilderInvoicesState.actionableInvoices,
  );
  private readonly listStatus = this.store.selectSignal(
    BuilderInvoicesState.actionableStatus,
  );
  private readonly card = this.store.selectSignal(BuilderBillingState.card);

  /** Banner UI state (NGXS + storage-plugin persistence). */
  private readonly dismissedIds = this.store.selectSignal(
    DueInvoiceBannersState.dismissedIds,
  );
  private readonly openIds = this.store.selectSignal(
    DueInvoiceBannersState.openIds,
  );
  protected readonly stackCollapsed = this.store.selectSignal(
    DueInvoiceBannersState.stackCollapsed,
  );

  /**
   * Invoices currently needing a banner: actionable by state and not
   * dismissed. Recomputed from store state, so a paid invoice drops out
   * automatically.
   */
  protected readonly dueInvoices = computed<readonly CommissionInvoice[]>(
    () => {
      if (this.listStatus() !== 'ready') {
        return [];
      }
      const dismissed = new Set(this.dismissedIds());
      return this.invoices().filter(
        (invoice) =>
          !dismissed.has(invoice.id) && dueReasonFor(invoice) !== null,
      );
    },
  );

  /** "N invoices need attention" / "1 invoice needs attention". */
  protected heading(count: number): string {
    return count === 1
      ? this.copy.dueBannersHeadingSingular
      : this.copy.dueBannersHeading.replace('{count}', String(count));
  }

  /** Bold lead of the collapsed bar, e.g. "Invoice INV-0042 overdue:". */
  protected barLead(invoice: CommissionInvoice): string {
    const reason = dueReasonFor(invoice);
    const key =
      reason === 'due-today'
        ? this.copy.dueBannersBarDueTodayLead
        : reason === 'overdue'
          ? this.copy.dueBannersBarOverdueLead
          : this.copy.dueBannersBarFailedLead;
    return key.replace('{number}', invoice.invoiceNumber);
  }

  /** Regular tail of the collapsed bar, e.g. "$10,000 — payment failed". */
  protected barTail(invoice: CommissionInvoice): string {
    const reason = dueReasonFor(invoice);
    const key =
      reason === 'due-today'
        ? this.copy.dueBannersBarDueTodayTail
        : reason === 'overdue'
          ? this.copy.dueBannersBarOverdueTail
          : this.copy.dueBannersBarFailedTail;
    return key.replace('{amount}', formatCentsToCad(invoice.commissionCents));
  }

  /**
   * Expanded meta line: "Invoice INV-0042 · Sep 29, 2026 · Ava Brown ·
   * $1,000,000 contract".
   */
  protected metaLine(invoice: CommissionInvoice): string {
    return this.copy.dueBannersMeta
      .replace('{number}', invoice.invoiceNumber)
      .replace('{date}', formatEdmontonMediumDate(invoice.createdAt))
      .replace('{lead}', invoice.leadName)
      .replace('{contract}', formatCentsToCad(invoice.contractValueCents));
  }

  /** "Payment method: Card •••• 4242 (change it on the invoice)". */
  protected methodLine(): string {
    const card = this.card();
    const method =
      card?.hasCard && card.last4
        ? this.copy.dueBannersCardLabel.replace('{last4}', card.last4)
        : this.copy.dueBannersNoCardOnFile;
    return this.copy.dueBannersMethodLine.replace('{method}', method);
  }

  protected isFailed(invoice: CommissionInvoice): boolean {
    return invoice.status === 'failed';
  }

  /** Whether this banner's detail body is expanded (NGXS UI state). */
  protected isOpen(id: string): boolean {
    return this.openIds().includes(id);
  }

  /** Toggle one banner's detail body. */
  protected toggleOpen(id: string): void {
    this.store.dispatch(new ToggleBannerOpen(id));
  }

  /** Fold/unfold the whole stack. */
  protected setStackCollapsed(collapsed: boolean): void {
    this.store.dispatch(new SetBannersCollapsed(collapsed));
  }

  protected dismissLabel(invoice: CommissionInvoice): string {
    return this.copy.dueBannersDismissLabel.replace(
      '{number}',
      invoice.invoiceNumber,
    );
  }

  /** × on one banner: stop the bar's toggle, dismiss (persists). */
  protected onDismiss(invoice: CommissionInvoice, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.store.dispatch(new DismissBanner(invoice.id));
  }

  protected onDismissKey(invoice: CommissionInvoice, event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      this.onDismiss(invoice, event);
    }
  }

  /** × on the slim summary bar: dismiss every visible banner. */
  protected onDismissAll(event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.store.dispatch(
      new DismissAllBanners(this.dueInvoices().map((invoice) => invoice.id)),
    );
  }

  protected onDismissAllKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      this.onDismissAll(event);
    }
  }
}
