/**
 * Display helpers for builder commission invoices (#533): the invoice
 * drawer, the change-method modal and the invoices list share them.
 *
 * Pure presentation — every figure and date comes from the API; nothing
 * here computes money. Copy comes in as an argument (config-owned).
 */
import type { CommissionInvoice } from '@feasly/contracts';
import type { TimelineEvent } from '@app/shared/ui';
import type { BuilderCopy } from '../../core/config/app-config';
import { edmontonDayDiff, formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import type { BuilderCommissionInvoice } from './builder-invoices-api.service';
import { paymentMethodLabel, type BuilderPaymentMethod } from './builder-payment-methods';

/** `{key}` placeholders → values. */
export function fillCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Day-level review-deadline countdown on the America/Edmonton calendar.
 * Null when the invoice is not in review or has no deadline. Method-aware
 * (Karan 2026-10-02): "Auto-charges" only for the card on file — manual
 * methods never auto-charge, so they get a plain "Due in X days".
 */
export function reviewCountdown(
  invoice: Pick<CommissionInvoice, 'status' | 'reviewDueAt'> & { readonly paymentMethod: BuilderPaymentMethod },
  copy: BuilderCopy,
): string | null {
  if (invoice.status !== 'in_review' || !invoice.reviewDueAt) {
    return null;
  }
  const days = edmontonDayDiff(invoice.reviewDueAt);
  if (days === null || days < 0) {
    return null;
  }
  const autoCharge = invoice.paymentMethod === 'card';
  if (days === 0) {
    return autoCharge ? copy.invoicesAutoChargeToday : copy.invoicesDueToday;
  }
  if (days === 1) {
    return autoCharge ? copy.invoicesAutoChargeTomorrow : copy.invoicesDueTomorrow;
  }
  return (autoCharge ? copy.invoicesAutoChargeIn : copy.invoicesDueIn).replace('{days}', String(days));
}

/**
 * The method can be changed until the invoice is settled: paid, void and
 * disputed invoices are locked with an explainer. An invoice waiting for
 * bank confirmation (#712) is locked too — its charge is in flight.
 */
export function paymentMethodEditable(invoice: Pick<CommissionInvoice, 'status'>): boolean {
  return (
    invoice.status !== 'paid' &&
    invoice.status !== 'void' &&
    invoice.status !== 'disputed' &&
    invoice.status !== 'action_required'
  );
}

/** Buyer-grade method label ("Card •••• 4242", "Cheque"). */
export function methodLabel(method: BuilderPaymentMethod, copy: BuilderCopy, last4?: string | null): string {
  return paymentMethodLabel(method, copy, last4);
}

/**
 * What a payment method does for this invoice, in one line. Reads the
 * method passed in — the drawer passes the SAVED method, the modal's
 * "after" panel passes the picked one — so the copy always describes what
 * the backend will do once that method is saved.
 */
export function methodEffect(
  invoice: BuilderCommissionInvoice,
  method: BuilderPaymentMethod,
  copy: BuilderCopy,
  last4?: string | null,
): string {
  const inReview = invoice.status === 'in_review' && !!invoice.reviewDueAt;
  const date = inReview ? formatEdmontonMediumDate(invoice.reviewDueAt) : '';
  if (method === 'card') {
    return inReview ? copy.invoicesReviewNote.replace('{date}', date) : copy.invoiceDrawer.modalEffectCard;
  }
  const label = methodLabel(method, copy, last4).toLowerCase();
  return inReview
    ? copy.invoicesReviewNoteManual.replace('{date}', date).replace('{method}', label)
    : copy.invoicesPaymentMethodManualNote.replace('{method}', label);
}

/** The rate the invoice was priced at (server-computed); null when absent. */
export function invoiceRatePercent(invoice: CommissionInvoice): number | null {
  return invoice.effectiveRatePercent ?? invoice.commissionRatePercent ?? null;
}

/**
 * Invoice events for the kit Timeline, built from the timestamps the
 * invoice carries. The Timeline sorts by timestamp, so a charge that failed
 * before finalize still renders in true order (#478, #533 AC1).
 */
export function invoiceTimelineEvents(invoice: CommissionInvoice, copy: BuilderCopy): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { id: 'created', at: invoice.createdAt, title: copy.invoicesTimelineCreated, tone: 'info' },
  ];
  if (invoice.reviewDueAt) {
    events.push({ id: 'review', at: invoice.reviewDueAt, title: copy.invoicesTimelineReviewEnds, tone: 'progress' });
  }
  if (invoice.finalizedAt) {
    events.push({ id: 'finalized', at: invoice.finalizedAt, title: copy.invoicesTimelineFinalized, tone: 'progress' });
  }
  if (invoice.paidAt) {
    events.push({ id: 'paid', at: invoice.paidAt, title: copy.invoicesTimelinePaid, tone: 'success' });
  } else if (invoice.status === 'failed') {
    events.push({ id: 'failed', at: invoice.updatedAt, title: copy.invoicesTimelineFailed, tone: 'danger' });
  }
  return events;
}
