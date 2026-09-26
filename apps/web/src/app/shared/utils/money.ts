/**
 * Money formatting utilities (shared).
 *
 * Backend amounts arrive as integer cents. All display math here is integer
 * math only — no float division — so 110 cents renders exactly "$1.10"
 * (admin/02 AC2: no float math in display).
 */

/**
 * Formats integer cents as CAD dollars.
 *
 * 110 -> "$1.10", 50000 -> "$500", 1234567 -> "$12,345.67".
 * Non-finite input renders as "$0" rather than crashing the UI.
 */
export function formatCentsToCad(cents: number): string {
  const normalized = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const sign = normalized < 0 ? '-' : '';
  const abs = Math.abs(normalized);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const grouped = dollars.toLocaleString('en-CA');
  return remainder === 0
    ? `${sign}$${grouped}`
    : `${sign}$${grouped}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Formats an integer-cents range as "$low – $high".
 *
 * [45000000, 52000000] -> "$450,000 – $520,000".
 */
export function formatCentsRangeToCad(range: readonly [number, number]): string {
  return `${formatCentsToCad(range[0])} – ${formatCentsToCad(range[1])}`;
}
