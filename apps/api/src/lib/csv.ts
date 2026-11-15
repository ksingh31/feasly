/**
 * CSV cell escaping (#728 finance exports). Pure, total: no input throws.
 *
 * - null/undefined → empty cell.
 * - Formula injection: a cell whose first non-whitespace character is
 *   = + - @ (or tab/CR) evaluates as a formula in Excel/Sheets; prefix a
 *   single quote so it opens as plain text.
 * - RFC 4180 quoting for commas, quotes and line breaks.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^\s*[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** One CSV line (no trailing newline). */
export function csvLine(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

/**
 * Integer cents → fixed two-decimal dollars ("1234.56"), the format
 * accounting imports expect. Exact: integer arithmetic, no float rounding.
 */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${dollars}.${rest}`;
}
