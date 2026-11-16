/**
 * CSV helpers (pure, no I/O). Cells are formula-injection safe: a cell
 * whose first non-whitespace character is = + - @ (or tab/CR) is prefixed
 * with a single quote so spreadsheet apps treat it as text.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (/^\s*[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** Header row + one line per row, CRLF-free (`\n`), trailing newline. */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  return `${lines.join('\n')}\n`;
}

/** #728 finance exports: alias used by the audit/finance export services. */
export const csvCell = escapeCsvCell;

/** One CSV line (no trailing newline). */
export function csvLine(values: readonly unknown[]): string {
  return values.map(escapeCsvCell).join(',');
}

/**
 * Integer cents to fixed two-decimal dollars ("1234.56"), the format
 * accounting imports expect. Exact: integer arithmetic, no float rounding.
 */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${dollars}.${rest}`;
}
