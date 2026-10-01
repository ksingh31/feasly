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
