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
