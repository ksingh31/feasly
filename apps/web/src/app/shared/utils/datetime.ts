/**
 * Datetime formatting utilities (shared).
 *
 * Pure string assembly for API wire shapes — no Date parsing of user input,
 * no timezone guessing beyond the device's own offset.
 */

/**
 * Compose a full ISO-8601 datetime with the LOCAL timezone offset from a
 * date-only picker value. The backend's zod schema requires an explicit
 * offset (`z.string().datetime({ offset: true })`), so a bare "2026-09-20"
 * is rejected — "2026-09-20T00:00:00-06:00" (offset varies by locale) is not.
 */
export function dateOnlyToIsoWithOffset(dateOnly: string): string {
  const probe = new Date(`${dateOnly}T00:00:00`);
  const offsetMin = -probe.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${dateOnly}T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(
    abs % 60,
  )}`;
}

/**
 * Today's local date as yyyy-MM-dd (for no-future-date validators).
 */
export function todayLocalDateString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;
/** 30-day month / 365-day year: coarse buckets for relative copy only. */
const MONTH_MS = 2_592_000_000;
const YEAR_MS = 31_536_000_000;

const relativeFormatter = new Intl.RelativeTimeFormat('en-CA', { numeric: 'auto' });

/** Shown for instants under a minute away — relative copy never uses seconds. */
export const RELATIVE_JUST_NOW = 'Just now';

/**
 * ISO instant → relative copy against `now` ("2 days ago", "in 3 hours",
 * "yesterday"). Never outputs seconds: anything under a minute is
 * "Just now". Returns '—' for null or unparseable input.
 */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) {
    return '—';
  }
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return '—';
  }
  const diff = time - now.getTime();
  const abs = Math.abs(diff);
  if (abs < MINUTE_MS) {
    return RELATIVE_JUST_NOW;
  }
  const steps: ReadonlyArray<readonly [number, number, Intl.RelativeTimeFormatUnit]> = [
    [HOUR_MS, MINUTE_MS, 'minute'],
    [DAY_MS, HOUR_MS, 'hour'],
    [WEEK_MS, DAY_MS, 'day'],
    [MONTH_MS, WEEK_MS, 'week'],
    [YEAR_MS, MONTH_MS, 'month'],
    [Number.POSITIVE_INFINITY, YEAR_MS, 'year'],
  ];
  const [, unitMs, unit] = steps.find(([limit]) => abs < limit) ?? steps[steps.length - 1];
  const sign = diff < 0 ? -1 : 1;
  return relativeFormatter.format(sign * Math.floor(abs / unitMs), unit);
}

/**
 * Local calendar date `days` days before `now`, as yyyy-MM-dd. Used by
 * date-range presets ("last 7 days" = daysAgo 6 … today). DST-safe:
 * steps the calendar date, never subtracts milliseconds.
 */
export function localDateStringDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
