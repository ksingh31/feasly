/**
 * Callback preferred-day helpers (#836).
 *
 * Presentation only: builds the day picker's options and formats a stored
 * `YYYY-MM-DD` day for display. The API is the authority — it re-validates
 * that the day is a weekday from tomorrow through the configured window on
 * the America/Edmonton calendar and rejects anything else.
 */
import { EDMONTON_TIME_ZONE } from './edmonton';

const MS_PER_DAY = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today on the Edmonton calendar, as `YYYY-MM-DD` (en-CA formats ISO-style). */
const edmontonDayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: EDMONTON_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** UTC-midnight instant → `YYYY-MM-DD` (en-CA formats ISO-style). */
const utcDayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar-day label ("Tuesday, Nov 18"). Keys are UTC midnights. */
const dayLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

export interface CallbackDayOption {
  /** `YYYY-MM-DD` sent to the API. */
  readonly value: string;
  readonly label: string;
}

function keyToUtc(key: string): number | null {
  const match = DATE_KEY.exec(key);
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(utc) ? null : utc;
}

/**
 * Weekdays from tomorrow through `windowDays` calendar days ahead
 * (Edmonton calendar), soonest first.
 */
export function callbackDayOptions(
  windowDays: number,
  now: Date = new Date(),
): CallbackDayOption[] {
  const today = keyToUtc(edmontonDayKey.format(now));
  if (today === null) return [];
  const options: CallbackDayOption[] = [];
  for (let offset = 1; offset <= windowDays; offset++) {
    const day = new Date(today + offset * MS_PER_DAY);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    options.push({ value: utcDayKey.format(day), label: dayLabel.format(day) });
  }
  return options;
}

/** `YYYY-MM-DD` → "Tuesday, Nov 18"; null for a missing or malformed key. */
export function formatCallbackDay(key: string | null | undefined): string | null {
  if (!key) return null;
  const utc = keyToUtc(key);
  return utc === null ? null : dayLabel.format(new Date(utc));
}
