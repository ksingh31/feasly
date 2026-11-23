/**
 * Refund + bank-chargeback state of a commission invoice (#719/#872), for
 * the admin and builder invoice drawers. Pure display mapping: every
 * figure is the server's (`refundedCents` is cumulative, integer cents).
 */
import type { ChargebackStatus, CommissionInvoice, InvoiceRefund } from '@feasly/contracts';

export interface InvoiceRecoveryState {
  /** Cumulative refund in cents; null when nothing was refunded. */
  readonly refundedCents: number | null;
  /** Chargeback state; null when the charge was never disputed with the bank. */
  readonly chargebackStatus: ChargebackStatus | null;
}

/** Null when there is nothing to show (no refund, never charged back). */
export function invoiceRecoveryState(
  invoice: Pick<CommissionInvoice, 'refundedCents' | 'chargebackStatus'>,
): InvoiceRecoveryState | null {
  const refunded =
    typeof invoice.refundedCents === 'number' && invoice.refundedCents > 0 ? invoice.refundedCents : null;
  const chargeback = invoice.chargebackStatus ?? null;
  return refunded === null && chargeback === null ? null : { refundedCents: refunded, chargebackStatus: chargeback };
}

/**
 * #862: what the builder paid after refunds — the server's total minus the
 * server's cumulative refund (the same figure the API returns as
 * `netCents` on a refund). Never below 0.
 */
export function netPaidCents(invoice: Pick<CommissionInvoice, 'totalCents' | 'refundedCents'>): number {
  return Math.max(0, invoice.totalCents - (invoice.refundedCents ?? 0));
}

/**
 * #862: refund records worth showing — failed attempts released their
 * amount and never moved money, so they are left out.
 */
export function visibleRefunds(invoice: Pick<CommissionInvoice, 'refunds'>): readonly InvoiceRefund[] {
  return (invoice.refunds ?? []).filter((r) => r.status !== 'failed');
}
