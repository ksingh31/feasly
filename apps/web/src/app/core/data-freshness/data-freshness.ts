/**
 * One freshness story (#513, consumer review S9).
 *
 * The landing trust strip and the property card used to tell two different
 * freshness stories ("November 2026 — Latest data refresh" vs "City-assessed
 * value, 2026 — data as of Jan 13, 2026"). Both now render the same line
 * from the same config templates:
 *
 *   "{year} assessment roll" + " " + "(City of Calgary) · checked {monthYear}"
 *   → "2026 assessment roll (City of Calgary) · checked Nov 2026"
 *
 * Pure string templating only — no figures, no business logic.
 */

/** Config-owned templates (`copy.dataFreshness`). */
export interface DataFreshnessCopy {
  /** Lead part when the roll year is known: "{year} assessment roll". */
  readonly rollTemplate: string;
  /** Lead part when the roll year is unknown: "Current assessment roll". */
  readonly rollUnknownYear: string;
  /** Trailing part when the check month is known: "(City of Calgary) · checked {monthYear}". */
  readonly detailTemplate: string;
  /** Trailing part when the check month is unknown: "(City of Calgary)". */
  readonly detailUnchecked: string;
}

/** The freshness line, split for layouts that stack lead + detail. */
export interface FreshnessLine {
  /** "2026 assessment roll" */
  readonly lead: string;
  /** "(City of Calgary) · checked Nov 2026" */
  readonly detail: string;
  /** lead + " " + detail — the single string every surface shows. */
  readonly line: string;
}

/** "September 2026" → "Sep 2026" (the review's "checked Nov 2026" form). */
export function shortMonthYear(monthYear: string): string {
  const [month = '', year = ''] = monthYear.trim().split(/\s+/);
  return `${month.slice(0, 3)} ${year}`.trim();
}

/**
 * Builds the shared freshness line. `year` is the assessment roll year;
 * `refreshedMonth` is the dataset check month ("September 2026"). Either may
 * be unknown — the line then drops that claim instead of guessing.
 */
export function formatFreshnessLine(
  copy: DataFreshnessCopy,
  year: number | string | null | undefined,
  refreshedMonth: string | null | undefined,
): FreshnessLine {
  const hasYear = year !== null && year !== undefined && String(year).trim() !== '';
  const lead = hasYear ? copy.rollTemplate.replace('{year}', String(year).trim()) : copy.rollUnknownYear;
  const month = refreshedMonth ? shortMonthYear(refreshedMonth) : '';
  const detail = month ? copy.detailTemplate.replace('{monthYear}', month) : copy.detailUnchecked;
  return { lead, detail, line: `${lead} ${detail}` };
}
