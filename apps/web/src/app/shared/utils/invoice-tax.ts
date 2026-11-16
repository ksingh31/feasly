/**
 * Sales-tax display helpers for commission invoices (#764).
 *
 * Presentation only: subtotal, tax and total arrive from the API as integer
 * cents (#714) — nothing here re-derives an invoice figure. The one
 * exception is `previewTaxCents`, a display-only estimate for the
 * record-contract preview before any invoice exists (the same contract as
 * `percentOfCents`): the backend computes the billed tax.
 */
import { formatCentsToCad, formatRatePercent, percentOfCents } from './money';

/** The invoice fields the tax breakdown reads (CommissionInvoice-shaped). */
export interface InvoiceTaxFields {
  readonly commissionCents: number;
  readonly subtotalCents?: number;
  readonly taxCents?: number;
  readonly totalCents?: number;
  readonly taxRatePercent?: number;
  readonly taxLabel?: string | null;
}

/** A taxed invoice's breakdown, ready to format. */
export interface InvoiceTaxBreakdown {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  /** "GST (5%)" — label plus the snapshotted rate; label alone without a rate. */
  readonly taxLine: string;
  /** The bare label, e.g. "GST". */
  readonly label: string;
}

/**
 * The invoice's tax breakdown, or null when it carries no tax (taxCents 0
 * or absent) — untaxed invoices render exactly as they did before #714.
 * `fallbackLabel` (config copy) covers a taxed invoice with no label.
 */
export function invoiceTaxBreakdown(invoice: InvoiceTaxFields, fallbackLabel: string): InvoiceTaxBreakdown | null {
  const taxCents = invoice.taxCents ?? 0;
  if (!(taxCents > 0) || invoice.totalCents === undefined) {
    return null;
  }
  const label = invoice.taxLabel?.trim() || fallbackLabel;
  const rate = invoice.taxRatePercent ?? 0;
  return {
    subtotalCents: invoice.subtotalCents ?? invoice.commissionCents,
    taxCents,
    totalCents: invoice.totalCents,
    taxLine: rate > 0 ? `${label} (${formatRatePercent(rate)})` : label,
    label,
  };
}

/** A taxed invoice's breakdown as display strings (exact to the cent). */
export interface FormattedInvoiceTax {
  /** "GST (5%)". */
  readonly line: string;
  readonly label: string;
  readonly subtotal: string;
  readonly amount: string;
  readonly total: string;
}

/** `invoiceTaxBreakdown`, formatted as CAD to the cent; null when untaxed. */
export function formatInvoiceTax(invoice: InvoiceTaxFields, fallbackLabel: string): FormattedInvoiceTax | null {
  const tax = invoiceTaxBreakdown(invoice, fallbackLabel);
  return tax
    ? {
        line: tax.taxLine,
        label: tax.label,
        subtotal: formatCentsToCad(tax.subtotalCents),
        amount: formatCentsToCad(tax.taxCents),
        total: formatCentsToCad(tax.totalCents),
      }
    : null;
}

/**
 * DISPLAY-ONLY tax estimate on a not-yet-issued commission, for the
 * record-contract preview (commission-plus-tax pricing). The backend
 * computes the billed tax.
 */
export function previewTaxCents(commissionCents: number, taxRatePercent: number): number {
  return percentOfCents(commissionCents, taxRatePercent);
}
