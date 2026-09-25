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
 * `round(contractValueCents * rate)`. Throws on non-positive contract
 * values or an out-of-range rate so callers fail fast instead of
 * under-billing.
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
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    throw new RangeError(`rate must be in (0, 1], got ${rate}`);
  }
  return Math.round(contractValueCents * rate);
}

/**
 * Whole days between two instants, floored. Used for SLA aging buckets
 * (e.g. how many days past the reporting deadline a report arrived).
 */
export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}
