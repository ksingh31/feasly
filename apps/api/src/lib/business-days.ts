/**
 * Pure business-day helpers (dispute console, billing/01 follow-on).
 *
 * Deterministic math only: no I/O, no clock, no env — callers inject every
 * timestamp they need. Business days are Monday–Friday on the given
 * timezone's calendar. Statutory holidays are NOT modeled (documented):
 * the dispute SLA counts calendar business days, matching how the ops
 * team reads "5 business days".
 *
 * The dispute SLA runs on America/Edmonton (Karan's timezone). Alberta
 * does not observe DST, but the helpers are timezone-correct in general
 * via Intl wall-clock reconstruction.
 */

const MS_PER_DAY = 86_400_000;

/** The timezone the dispute SLA countdown is computed in. */
export const DISPUTE_SLA_TIMEZONE = 'America/Edmonton';
/** Business days from dispute-open to the SLA deadline. */
export const DISPUTE_SLA_BUSINESS_DAYS = 5;

interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly ms: number;
}

const wallFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

/** Decompose an instant into wall-clock parts in the timezone. */
function zonedParts(instant: Date, timeZone: string): WallParts {
  const lookup = new Map<string, string>();
  for (const part of wallFormatter(timeZone).formatToParts(instant)) {
    lookup.set(part.type, part.value);
  }
  const num = (key: string): number => Number(lookup.get(key));
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    // 'en-US' with hour12:false can emit hour '24' at midnight — normalize.
    hour: num('hour') % 24,
    minute: num('minute'),
    second: num('second'),
    ms: instant.getMilliseconds(),
  };
}

/** Zone offset (ms) at an instant, via the Intl round-trip trick. */
function zoneOffsetMs(timeZone: string, utcInstant: Date): number {
  const wall = zonedParts(utcInstant, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - utcInstant.getTime();
}

/** Reconstruct an instant from wall-clock parts in the timezone. */
function wallToInstant(wall: WallParts, timeZone: string): Date {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.ms,
  );
  return new Date(guess - zoneOffsetMs(timeZone, new Date(guess)));
}

/** True for Monday–Friday. Weekday is a pure function of the calendar date. */
function isWeekdayDate(year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/**
 * True when the instant falls on a business day (Mon–Fri) in the timezone.
 */
export function isBusinessDay(instant: Date, timeZone: string): boolean {
  const wall = zonedParts(instant, timeZone);
  return isWeekdayDate(wall.year, wall.month, wall.day);
}

/**
 * Advance `businessDays` business days from `from`, preserving the
 * wall-clock time-of-day in the timezone. E.g. Monday 10:00 + 5 business
 * days = next Monday 10:00 (all America/Edmonton).
 */
export function addBusinessDays(
  from: Date,
  businessDays: number,
  timeZone: string,
): Date {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new RangeError(
      `businessDays must be a non-negative integer, got ${businessDays}`,
    );
  }
  const wall = zonedParts(from, timeZone);
  let year = wall.year;
  let month = wall.month;
  let day = wall.day;
  let remaining = businessDays;
  while (remaining > 0) {
    const next = new Date(Date.UTC(year, month - 1, day) + MS_PER_DAY);
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
    if (isWeekdayDate(year, month, day)) {
      remaining -= 1;
    }
  }
  return wallToInstant({ ...wall, year, month, day }, timeZone);
}

/**
 * Whole business days from `from` to `to` on the timezone's calendar:
 * counts each business-day calendar date in (fromDate, toDate]. Positive
 * when `to` is later, negative when earlier, 0 on the same calendar date.
 * Used for the SLA countdown (negative = breached).
 */
export function businessDaysBetween(
  from: Date,
  to: Date,
  timeZone: string,
): number {
  const fromWall = zonedParts(from, timeZone);
  const toWall = zonedParts(to, timeZone);
  const fromDay = Date.UTC(fromWall.year, fromWall.month - 1, fromWall.day);
  const toDay = Date.UTC(toWall.year, toWall.month - 1, toWall.day);
  if (fromDay === toDay) {
    return 0;
  }
  const forward = toDay > fromDay;
  const start = forward ? fromDay : toDay;
  const end = forward ? toDay : fromDay;
  let count = 0;
  for (let day = start + MS_PER_DAY; day <= end; day += MS_PER_DAY) {
    const d = new Date(day);
    if (isWeekdayDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) {
      count += 1;
    }
  }
  return forward ? count : -count;
}
