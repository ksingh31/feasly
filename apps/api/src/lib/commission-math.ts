/**
 * Pure commission math (billing/02).
 *
 * Deterministic math only: no I/O, no clock, no env. Money is integer
 * cents — never float. Callers pass the configured rate (fraction); the
 * default matches Karan's 2026-09-24 decision (1% of the signed
 * construction contract value, excl. land).
 */

const MS_PER_DAY = 86_400_000;

/**
 * The commission owed on a signed contract, in integer cents:
 * `round(contractValueCents * rate)`. A 0% negotiated rate is legitimate
 * (returns 0). Throws on non-positive contract values or an out-of-range
 * rate so callers fail fast instead of under-billing.
 */
export function computeCommissionCents(
  contractValueCents: number,
  rate: number,
): number {
  if (!Number.isInteger(contractValueCents) || contractValueCents <= 0) {
    throw new RangeError(
      `contractValueCents must be a positive integer, got ${contractValueCents}`,
    );
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError(`rate must be in [0, 1], got ${rate}`);
  }
  return Math.round(contractValueCents * rate);
}

/**
 * The effective commission rate for an invoice, in PERCENT.
 *
 * Precedence (billing/08): the per-invoice admin override when set,
 * otherwise the builder's rate snapshotted at invoice creation, otherwise
 * the configured default (`defaultRate` is the FRACTION, e.g. 0.01).
 * Rounds to 4 decimals so config fractions (0.01 → 1%) and 4-decimal
 * overrides round-trip cleanly for display and audit payloads.
 */
export function effectiveRatePercent(
  row: {
    readonly commissionRateOverride: number | null;
    readonly commissionRatePercent: number | null;
  },
  defaultRate: number,
): number {
  const pct =
    row.commissionRateOverride ?? row.commissionRatePercent ?? defaultRate * 100;
  return Math.round(pct * 10_000) / 10_000;
}

/**
 * '1%' / '1.5%' — for PaymentIntent descriptions and admin UI labels.
 * Trims float dust from stored percents.
 */
export function formatRatePercent(ratePercent: number): string {
  const rounded = Math.round(ratePercent * 10_000) / 10_000;
  return `${Number(rounded.toFixed(4))}%`;
}

/**
 * Whole days between two instants, floored. Used for SLA aging buckets
 * (e.g. how many days past the reporting deadline a report arrived).
 */
export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}
