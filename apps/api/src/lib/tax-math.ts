/**
 * Pure sales-tax math for commission invoices (#714, GST).
 *
 * Deterministic math only: no I/O, no clock, no env. Money is integer
 * cents, never float. The tax rate arrives in PERCENT (5 = 5% GST) and is
 * normalised to 4 decimals, the same precision as commission rates.
 *
 * Rounding rule (documented, tested): tax is computed ONCE per invoice on
 * the invoice subtotal and rounded half-up to the nearest cent. Products
 * are done in BigInt so the result is exact for any realistic contract.
 *
 * Two pricing modes (owner decision 2026-11-15, default "commission plus
 * GST"):
 * - exclusive (default): subtotal = the commission; tax = round(subtotal ×
 *   rate); total = subtotal + tax.
 * - inclusive: total = the commission; tax = round(total × rate / (1 +
 *   rate)); subtotal = total − tax.
 *
 * A 0% rate (tax disabled, or a legacy invoice) returns tax 0 and
 * total = subtotal = commission: exactly today's figures.
 */

/** Rate precision: 4 decimals of a percent → integer units of 1e-4 %. */
const RATE_UNITS_PER_PERCENT = 10_000n;
/** 100% expressed in rate units. */
const HUNDRED_PERCENT_UNITS = 100n * RATE_UNITS_PER_PERCENT;

export interface InvoiceTaxBreakdown {
  /** Pre-tax amount (the commission), integer cents. */
  readonly subtotalCents: number;
  /** Tax amount, integer cents. */
  readonly taxCents: number;
  /** subtotal + tax — the amount charged, integer cents. */
  readonly totalCents: number;
}

/** Round a 4-decimal percent, trimming float dust (5.00000001 → 5). */
export function normaliseTaxRatePercent(ratePercent: number): number {
  return Math.round(ratePercent * 10_000) / 10_000;
}

/** Half-up division of non-negative BigInts. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Split a commission into subtotal / tax / total.
 *
 * `commissionCents` is round(contract × commission rate). In exclusive mode
 * it is the subtotal; in inclusive mode it is the total. Throws on negative
 * or non-integer cents and on a rate outside [0, 100] so callers fail fast
 * instead of mis-billing.
 */
export function computeInvoiceTax(
  commissionCents: number,
  taxRatePercent: number,
  inclusive: boolean,
): InvoiceTaxBreakdown {
  if (!Number.isSafeInteger(commissionCents) || commissionCents < 0) {
    throw new RangeError(
      `commissionCents must be a non-negative integer, got ${commissionCents}`,
    );
  }
  if (
    !Number.isFinite(taxRatePercent) ||
    taxRatePercent < 0 ||
    taxRatePercent > 100
  ) {
    throw new RangeError(
      `taxRatePercent must be in [0, 100], got ${taxRatePercent}`,
    );
  }
  const units = BigInt(Math.round(taxRatePercent * 10_000));
  const amount = BigInt(commissionCents);
  if (units === 0n) {
    return {
      subtotalCents: commissionCents,
      taxCents: 0,
      totalCents: commissionCents,
    };
  }
  if (inclusive) {
    const tax = divRoundHalfUp(amount * units, HUNDRED_PERCENT_UNITS + units);
    return {
      subtotalCents: Number(amount - tax),
      taxCents: Number(tax),
      totalCents: commissionCents,
    };
  }
  const tax = divRoundHalfUp(amount * units, HUNDRED_PERCENT_UNITS);
  return {
    subtotalCents: commissionCents,
    taxCents: Number(tax),
    totalCents: Number(amount + tax),
  };
}

/**
 * Pro-rata share of an invoice's tax for a partial amount of its total
 * (refunds / credit notes, #715): round(taxCents × partTotal / total),
 * half-up. A full refund (part = total) returns the full tax exactly.
 */
export function proportionalTaxCents(
  invoice: Pick<InvoiceTaxBreakdown, 'taxCents' | 'totalCents'>,
  partTotalCents: number,
): number {
  if (
    !Number.isSafeInteger(partTotalCents) ||
    partTotalCents < 0 ||
    partTotalCents > invoice.totalCents
  ) {
    throw new RangeError(
      `partTotalCents must be an integer in [0, ${invoice.totalCents}], got ${partTotalCents}`,
    );
  }
  if (invoice.totalCents === 0) return 0;
  return Number(
    divRoundHalfUp(
      BigInt(invoice.taxCents) * BigInt(partTotalCents),
      BigInt(invoice.totalCents),
    ),
  );
}

/** '5%' / '13%' / '14.975%' for tax labels. Trims float dust. */
export function formatTaxRatePercent(ratePercent: number): string {
  return `${Number(normaliseTaxRatePercent(ratePercent).toFixed(4))}%`;
}
