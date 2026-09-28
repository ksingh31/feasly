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
