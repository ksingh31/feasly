/**
 * Pure billing-deadline helpers (billing/01 foundation).
 *
 * Deterministic math only: no I/O, no clock, no env — callers inject every
 * timestamp they need. Money is integer cents; durations are whole days.
 *
 * Two deadlines drive the commission model (Karan 2026-09-24):
 * - Attribution: a contract signed within BILLING_ATTRIBUTION_WINDOW_DAYS
 *   (12 months) of the lead→builder introduction attributes to Feasly.
 * - Reporting SLA: the builder must report the signed contract within
 *   BILLING_REPORTING_SLA_DAYS (14 days) of the signature date.
 */

const MS_PER_DAY = 86_400_000;

/**
 * The last instant a signed contract still attributes: introducedAt +
 * windowDays, end-of-day inclusive. Returns a Date (new instance).
 */
export function attributionDeadline(introducedAt: Date, windowDays: number): Date {
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new RangeError(`windowDays must be a positive integer, got ${windowDays}`);
  }
  return new Date(introducedAt.getTime() + windowDays * MS_PER_DAY);
}

/**
 * True when the contract signature at `signedAt` falls inside the
 * attribution window that opened at `introducedAt`. The deadline instant
 * itself counts as inside (inclusive).
 */
export function isWithinAttributionWindow(
  introducedAt: Date,
  signedAt: Date,
  windowDays: number,
): boolean {
  return signedAt.getTime() <= attributionDeadline(introducedAt, windowDays).getTime();
}

/**
 * The last instant the builder may report the contract without breaching
 * the SLA: contractSignedAt + slaDays, end-of-day inclusive.
 */
export function reportingDeadline(contractSignedAt: Date, slaDays: number): Date {
  if (!Number.isInteger(slaDays) || slaDays <= 0) {
    throw new RangeError(`slaDays must be a positive integer, got ${slaDays}`);
  }
  return new Date(contractSignedAt.getTime() + slaDays * MS_PER_DAY);
}

/**
 * True when `reportedAt` is on or before the reporting deadline.
 */
export function isReportingOnTime(
  contractSignedAt: Date,
  reportedAt: Date,
  slaDays: number,
): boolean {
  return reportedAt.getTime() <= reportingDeadline(contractSignedAt, slaDays).getTime();
}

/**
 * Whole days from `now` until `deadline`, floored. Negative means overdue
 * (e.g. -1 = one full day past the deadline).
 */
export function wholeDaysUntil(deadline: Date, now: Date): number {
  return Math.floor((deadline.getTime() - now.getTime()) / MS_PER_DAY);
}
