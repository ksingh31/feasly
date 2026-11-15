/**
 * America/Edmonton billing-calendar helpers (shared).
 *
 * Commission invoice review deadlines are evaluated on the Edmonton
 * calendar at day granularity: the builder-invoices countdown and the
 * dashboard due-invoice banners share these helpers so "due today" means
 * the same day on both surfaces.
 */

/** IANA zone for the billing calendar. */
export const EDMONTON_TIME_ZONE = 'America/Edmonton';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: EDMONTON_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const mediumFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: EDMONTON_TIME_ZONE,
  dateStyle: 'medium',
});

/**
 * Whole-day difference between an ISO instant and today on the Edmonton
 * calendar: 0 = today, positive = days in the future, negative = days
 * overdue. Returns null when the instant is unparseable.
 */
export function edmontonDayDiff(iso: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.round(
    (Date.parse(dayFormatter.format(date)) -
      Date.parse(dayFormatter.format(new Date()))) /
      86_400_000,
  );
}

/**
 * ISO instant → Edmonton medium date ("Sep 29, 2026"). Returns '—' for
 * null or unparseable input.
 */
export function formatEdmontonMediumDate(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return mediumFormatter.format(date);
}

const timeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: EDMONTON_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

/** Suffix naming the zone every portal timestamp is shown in. */
export const EDMONTON_ZONE_LABEL = 'MT';

/**
 * ISO instant → Edmonton date and time without seconds
 * ("Nov 12, 2026 · 11:30 a.m. MT"). Returns '—' for null or unparseable
 * input — never the raw ISO string.
 */
export function formatEdmontonDateTime(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const day = mediumFormatter.format(date);
  const time = timeFormatter.format(date);
  return `${day} · ${time} ${EDMONTON_ZONE_LABEL}`;
}

const utcMediumFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  dateStyle: 'medium',
});

/**
 * Today on the Edmonton calendar plus `days` whole days, as a medium date
 * ("Nov 22, 2026"). Calendar arithmetic only (no DST drift): used to name
 * an expected charge date before the invoice that fixes it exists.
 */
export function formatEdmontonDatePlusDays(days: number, now: Date = new Date()): string {
  const today = Date.parse(dayFormatter.format(now)); // yyyy-mm-dd → UTC midnight
  return utcMediumFormatter.format(new Date(today + days * 86_400_000));
}
