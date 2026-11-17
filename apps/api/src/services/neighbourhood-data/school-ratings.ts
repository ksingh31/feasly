/**
 * School ratings (#776) — pure helpers, no I/O.
 *
 * None of the three sources publishes an open data feed, so the free
 * `published-reports` provider turns a curated list transcribed from the
 * published reports (`school-ratings.data.ts`) into one record per school and
 * kind:
 * - `fraser` — Fraser Institute report-card overall score (out of 10) + year;
 * - `provincial` — Alberta Education provincial results summary (PAT 6 /
 *   PAT 9 / diploma: % acceptable standard, % standard of excellence);
 * - `enrolment` — CBE annual enrolment report: enrolment vs capacity.
 *
 * Every entry carries its source URL. Nothing is estimated: a school without
 * an entry simply has no figure (served as null → "n/a").
 * Fraser entries are dropped unless `fraserEnabled` (owner: prod stays off
 * until Fraser's permission is confirmed).
 */
import { PROVINCIAL_TESTS, type ProvincialTest } from '@feasly/contracts';
import { httpsUrlOrNull, schoolRatingKey } from '../../lib/school-ratings';
import type { SchoolRatingRecord } from './providers';

interface CuratedBase {
  /** Directory school id (#774, GET /api/v1/schools/{id}). */
  readonly schoolId: string;
  /** The published report or page this entry was transcribed from (https). */
  readonly sourceUrl: string;
}

export interface CuratedFraserRating extends CuratedBase {
  readonly kind: 'fraser';
  /** Overall rating out of 10, as published. */
  readonly score: number;
  /** Report-card year, e.g. '2025'. */
  readonly year: string;
}

export interface CuratedProvincialResults extends CuratedBase {
  readonly kind: 'provincial';
  /** School year, e.g. '2024-25'. */
  readonly schoolYear: string;
  readonly tests: readonly {
    readonly test: ProvincialTest;
    readonly acceptableStandardPct: number | null;
    readonly excellenceStandardPct: number | null;
  }[];
}

export interface CuratedEnrolment extends CuratedBase {
  readonly kind: 'enrolment';
  /** School year, e.g. '2025-26'. */
  readonly schoolYear: string;
  readonly enrolment: number;
  readonly capacity: number;
}

/** One curated list entry. */
export type CuratedSchoolRating = CuratedFraserRating | CuratedProvincialResults | CuratedEnrolment;

/** A curated entry failed validation — fails the refresh (keeps the old data). */
export class InvalidSchoolRatingError extends Error {
  constructor(index: number, reason: string) {
    super(`school rating entry ${index}: ${reason}`);
    this.name = 'InvalidSchoolRatingError';
  }
}

export interface BuildRatingRecordsOptions {
  /** Config: store Fraser scores only when true. */
  readonly fraserEnabled: boolean;
}

function isPct(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Curated entries → rating records. Throws on an invalid or duplicated
 * entry: a half-valid list would silently drop or misattribute figures.
 */
export function buildRatingRecords(
  entries: readonly CuratedSchoolRating[],
  options: BuildRatingRecordsOptions,
): SchoolRatingRecord[] {
  const seen = new Set<string>();
  const out: SchoolRatingRecord[] = [];
  entries.forEach((entry, i) => {
    const schoolId = isNonEmpty(entry.schoolId) ? entry.schoolId.trim() : '';
    if (!schoolId) throw new InvalidSchoolRatingError(i, 'missing school id');
    const sourceUrl = httpsUrlOrNull(entry.sourceUrl);
    if (!sourceUrl) throw new InvalidSchoolRatingError(i, 'source URL must be an https URL');
    const externalId = schoolRatingKey(entry.kind, schoolId);
    if (seen.has(externalId)) throw new InvalidSchoolRatingError(i, `duplicate ${externalId}`);
    seen.add(externalId);

    switch (entry.kind) {
      case 'fraser': {
        if (typeof entry.score !== 'number' || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 10) {
          throw new InvalidSchoolRatingError(i, 'Fraser score must be 0-10');
        }
        if (!/^\d{4}$/.test(entry.year)) throw new InvalidSchoolRatingError(i, 'Fraser year must be YYYY');
        if (!options.fraserEnabled) return;
        out.push({
          externalId,
          schoolRef: schoolId,
          rating: entry.score,
          period: entry.year,
          data: { kind: 'fraser', score: entry.score, year: entry.year, sourceUrl },
        });
        return;
      }
      case 'provincial': {
        if (!isNonEmpty(entry.schoolYear)) throw new InvalidSchoolRatingError(i, 'missing school year');
        if (!Array.isArray(entry.tests) || entry.tests.length === 0) {
          throw new InvalidSchoolRatingError(i, 'no provincial test results');
        }
        const tests = new Set<string>();
        for (const t of entry.tests) {
          if (!PROVINCIAL_TESTS.includes(t.test)) throw new InvalidSchoolRatingError(i, 'unknown test');
          if (tests.has(t.test)) throw new InvalidSchoolRatingError(i, `duplicate test ${t.test}`);
          tests.add(t.test);
          if (!isPct(t.acceptableStandardPct) || !isPct(t.excellenceStandardPct)) {
            throw new InvalidSchoolRatingError(i, 'percent must be 0-100 or null');
          }
        }
        out.push({
          externalId,
          schoolRef: schoolId,
          rating: null,
          period: entry.schoolYear.trim(),
          data: {
            kind: 'provincial',
            schoolYear: entry.schoolYear.trim(),
            tests: entry.tests.map((t) => ({
              test: t.test,
              acceptableStandardPct: t.acceptableStandardPct,
              excellenceStandardPct: t.excellenceStandardPct,
            })),
            sourceUrl,
          },
        });
        return;
      }
      case 'enrolment': {
        if (!isNonEmpty(entry.schoolYear)) throw new InvalidSchoolRatingError(i, 'missing school year');
        if (!Number.isInteger(entry.enrolment) || entry.enrolment < 0) {
          throw new InvalidSchoolRatingError(i, 'enrolment must be a whole number');
        }
        if (!Number.isInteger(entry.capacity) || entry.capacity <= 0) {
          throw new InvalidSchoolRatingError(i, 'capacity must be a positive whole number');
        }
        out.push({
          externalId,
          schoolRef: schoolId,
          rating: null,
          period: entry.schoolYear.trim(),
          data: {
            kind: 'enrolment',
            schoolYear: entry.schoolYear.trim(),
            enrolment: entry.enrolment,
            capacity: entry.capacity,
            sourceUrl,
          },
        });
        return;
      }
      default:
        throw new InvalidSchoolRatingError(i, 'unknown kind');
    }
  });
  return out;
}
