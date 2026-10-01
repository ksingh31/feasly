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

/**
 * Formats whole CAD dollars (no cents) — the unit the web report snapshots
 * carry. 1480000 -> "$1,480,000". Non-finite input renders as "$0".
 */
export function formatWholeCad(value: number): string {
  const normalized = Number.isFinite(value) ? Math.round(value) : 0;
  return `$${normalized.toLocaleString('en-CA')}`;
}

/**
 * Converts a dollar amount to integer cents (rounds the float).
 * Centralizes the dollars→cents conversion so components never carry a
 * magic 100 — the per-sqft rate on the report is a dollar float.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Parses a CAD dollars string into integer cents with integer math only
 * (no float multiplication — "650000.50" -> 65000050, not 65000049.99…).
 *
 * Tolerates currency formatting characters ("$650,000"). Returns null for
 * anything that is not a non-negative dollars amount with at most 2
 * decimal places (the backend's `contractValueCents` is integer cents).
 */
export function parseCadDollarsToCents(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim().replace(/[$,\s]/g, '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const dollars = Number(match[1]);
  const frac = (match[2] ?? '').padEnd(2, '0');
  return dollars * 100 + Number(frac);
}

/**
 * Computes the 1% platform commission on a contract value (integer cents).
 *
 * DISPLAY-ONLY — the backend computes the billed amount. 65000000 -> 650000.
 * Kept for call sites that predate per-builder rates (billing/08).
 */
export function onePercentOfCents(cents: number): number {
  return Math.round(cents / 100);
}

/**
 * Computes the commission on a contract value (integer cents) at a
 * negotiated rate (percent, e.g. 1 = 1%).
 *
 * DISPLAY-ONLY — the backend computes the billed amount.
 */
export function percentOfCents(cents: number, ratePercent: number): number {
  return Math.round((cents * ratePercent) / 100);
}

/** Formats a rate percent for copy, e.g. 1 -> "1%", 1.5 -> "1.5%". */
export function formatRatePercent(ratePercent: number): string {
  const rounded = Math.round(ratePercent * 10_000) / 10_000;
  return `${Number(rounded.toFixed(4))}%`;
}
