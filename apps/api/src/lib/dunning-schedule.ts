/**
 * Dunning schedule math (#718). Pure — no I/O, no clock.
 *
 * Owner decision (2026-11-15): the retry schedule follows each invoice's
 * grace period. Admin can edit it per invoice and pause, resume or cancel
 * retries; the builder portal can only pay now.
 *
 * - Card invoice: a failed charge is retried `graceDays` after it failed,
 *   up to BILLING_MAX_CHARGE_RETRIES retries. After the last one fails the
 *   invoice is flagged for collections.
 * - Manual-method invoice (cheque, e-transfer, bank draft): due `graceDays`
 *   after its review window closes; past that it is overdue.
 */

export const DUNNING_STATES = ['active', 'paused', 'cancelled'] as const;
export type DunningState = (typeof DUNNING_STATES)[number];

/** Fallback when config omits the default grace period. */
export const DEFAULT_DUNNING_GRACE_DAYS = 7;
/** Bounds for an admin-set per-invoice grace period, in days. */
export const MIN_DUNNING_GRACE_DAYS = 1;
export const MAX_DUNNING_GRACE_DAYS = 90;

const DAY_MS = 86_400_000;

/** The invoice's grace period: its own override, else the configured default. */
export function effectiveGraceDays(
  override: number | null,
  configuredDefault: number | undefined,
): number {
  return override ?? configuredDefault ?? DEFAULT_DUNNING_GRACE_DAYS;
}

/** When a charge that failed at `failedAt` is next retried. */
export function retryDueAt(failedAt: Date, graceDays: number): Date {
  return new Date(failedAt.getTime() + graceDays * DAY_MS);
}

/** Due date of a manual-method invoice: review window end + grace period. */
export function manualDueAt(reviewDueAt: Date, graceDays: number): Date {
  return new Date(reviewDueAt.getTime() + graceDays * DAY_MS);
}

/** Whole days `now` is past `dueAt`; 0 when not yet due. */
export function daysOverdue(dueAt: Date, now: Date): number {
  const ms = now.getTime() - dueAt.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / DAY_MS);
}

/** True once every automatic retry has been used. */
export function retriesExhausted(retryCount: number, maxRetries: number): boolean {
  return retryCount >= maxRetries;
}

export function isDunningState(value: string): value is DunningState {
  return (DUNNING_STATES as ReadonlyArray<string>).includes(value);
}
