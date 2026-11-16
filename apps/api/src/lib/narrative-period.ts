/**
 * Community-narrative period math (#759). Pure — no I/O, no clock.
 *
 * A period is the month a narrative is SERVED for, as `YYYY-MM` (UTC).
 * The job runs on the run day of month M (default: its last day) and
 * generates period M+1; the following `retryDays` daily ticks retry
 * communities that failed. All dates are UTC calendar dates.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM` for the UTC month containing `date`. */
export function periodOf(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

/** Last calendar day (28-31) of the UTC month `year`/`month0`. */
function lastDayOf(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** The scheduled run (or retry) the date falls in. */
export interface NarrativeRunWindow {
  /** Period being generated (the month after the run day). */
  readonly period: string;
  /** 0 on the run day, 1..retryDays on retry days. */
  readonly daysSinceRunDay: number;
}

/**
 * Which period (if any) a tick on `now` should generate: the run day of
 * this month or the previous one, plus `retryDays` days after it.
 * Null on every other day.
 */
export function runWindowFor(
  now: Date,
  runDay: 'last' | number,
  retryDays: number,
): NarrativeRunWindow | null {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const offset of [0, -1]) {
    const year = now.getUTCFullYear();
    const month0 = now.getUTCMonth() + offset;
    const anchor = new Date(Date.UTC(year, month0, 1));
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth();
    const day = runDay === 'last' ? lastDayOf(y, m) : Math.min(runDay, lastDayOf(y, m));
    const runDate = Date.UTC(y, m, day);
    const daysSince = Math.round((today - runDate) / DAY_MS);
    if (daysSince >= 0 && daysSince <= retryDays) {
      return {
        period: periodOf(new Date(Date.UTC(y, m + 1, 1))),
        daysSinceRunDay: daysSince,
      };
    }
  }
  return null;
}
