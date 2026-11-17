/**
 * Schools directory reads (#774) — the request-path side.
 *
 * Serves ONLY from the `schools` table, filled by the monthly refresh job.
 * Like `neighbourhood-read.service.ts` it has no provider dependency, so a
 * visitor can never trigger an outside call (test/schools-directory.read
 * .test.ts asserts zero provider calls; the static import check in
 * test/neighbourhood-data.read.test.ts covers this module too).
 */
import {
  PROVINCIAL_TESTS,
  SCHOOL_TYPES,
  type FraserSchoolRating,
  type ProvincialResultsSummary,
  type ProvincialTestResult,
  type School,
  type SchoolEnrolment,
  type SchoolRatings,
  type SchoolReviewsLink,
  type SchoolAttributedField,
  type SchoolProgram,
  type SchoolSourceAttribution,
  type SchoolSourceId,
  type SchoolType,
} from '@feasly/contracts';
import type {
  NeighbourhoodDataStore,
  StoredDirectorySchool,
  StoredSchoolRating,
} from './neighbourhood-data.store';
import { SCHOOL_SOURCE_ATTRIBUTIONS } from '../../lib/school-sources';
import {
  NO_REVIEWS_LINK,
  SCHOOL_RATING_ATTRIBUTIONS,
  httpsUrlOrNull,
  utilizationPct,
  type SchoolReviewsLinker,
} from '../../lib/school-ratings';

/** Copy guard (epic rules: "confirm with the board"; no accuracy claims). */
export const SCHOOLS_DISCLAIMER =
  'School details change from year to year. Confirm grades, programs and enrolment with the school or board.';

export interface SchoolDirectoryQuery {
  readonly communityCode?: string;
  readonly type?: SchoolType;
}

export interface SchoolDirectoryList {
  readonly schools: readonly School[];
  readonly attributions: readonly SchoolSourceAttribution[];
}

export interface SchoolDirectoryReadService {
  listSchools(query: SchoolDirectoryQuery): Promise<SchoolDirectoryList>;
  /** Null when no school has that id. */
  getSchool(id: string): Promise<{ school: School; attributions: readonly SchoolSourceAttribution[] } | null>;
}

export interface SchoolDirectoryReadServiceDeps {
  readonly store: Pick<NeighbourhoodDataStore, 'listSchools' | 'getSchool' | 'listSchoolRatings'>;
  /** #776 config: Fraser scores returned only when true (also filtered at write). */
  readonly fraserEnabled?: boolean;
  /** #776: the configured reviews provider's link builder (default: no link). */
  readonly reviewsLink?: SchoolReviewsLinker;
}

const SOURCE_IDS = Object.keys(SCHOOL_SOURCE_ATTRIBUTIONS) as SchoolSourceId[];

function isSchoolType(value: unknown): value is SchoolType {
  return typeof value === 'string' && (SCHOOL_TYPES as readonly string[]).includes(value);
}

function isSourceId(value: unknown): value is SchoolSourceId {
  return typeof value === 'string' && (SOURCE_IDS as readonly string[]).includes(value);
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** No published figure — every field null (UI shows "n/a"). */
export const NO_RATINGS: SchoolRatings = { fraser: null, provincialResults: null, enrolment: null };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pctOrNull(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}

function toFraser(data: Record<string, unknown>, sourceUrl: string): FraserSchoolRating | null {
  const score = finite(data['score']);
  const year = strOrNull(data['year']);
  if (score === null || score < 0 || score > 10 || !year) return null;
  return { score, year, attribution: SCHOOL_RATING_ATTRIBUTIONS.fraser, sourceUrl };
}

function toProvincial(data: Record<string, unknown>, sourceUrl: string): ProvincialResultsSummary | null {
  const schoolYear = strOrNull(data['schoolYear']);
  if (!schoolYear || !Array.isArray(data['tests'])) return null;
  const tests: ProvincialTestResult[] = [];
  for (const raw of data['tests']) {
    const t = asRecord(raw);
    const test = t['test'];
    if (typeof test !== 'string' || !(PROVINCIAL_TESTS as readonly string[]).includes(test)) continue;
    tests.push({
      test: test as ProvincialTestResult['test'],
      acceptableStandardPct: pctOrNull(t['acceptableStandardPct']),
      excellenceStandardPct: pctOrNull(t['excellenceStandardPct']),
    });
  }
  if (tests.length === 0) return null;
  return { schoolYear, tests, attribution: SCHOOL_RATING_ATTRIBUTIONS.provincial, sourceUrl };
}

function toEnrolment(data: Record<string, unknown>, sourceUrl: string): SchoolEnrolment | null {
  const schoolYear = strOrNull(data['schoolYear']);
  const enrolment = finite(data['enrolment']);
  const capacity = finite(data['capacity']);
  if (!schoolYear || enrolment === null || capacity === null) return null;
  if (!Number.isInteger(enrolment) || enrolment < 0 || !Number.isInteger(capacity) || capacity <= 0) return null;
  return {
    schoolYear,
    enrolment,
    capacity,
    utilizationPct: utilizationPct(enrolment, capacity),
    attribution: SCHOOL_RATING_ATTRIBUTIONS.enrolment,
    sourceUrl,
  };
}

/**
 * One school's stored rating rows → its ratings. Anything malformed or
 * unsourced is dropped (null), never patched up. Fraser is null unless enabled.
 */
export function toRatings(rows: readonly StoredSchoolRating[], fraserEnabled: boolean): SchoolRatings {
  let ratings: SchoolRatings = NO_RATINGS;
  for (const row of rows) {
    const data = asRecord(row.data);
    const sourceUrl = httpsUrlOrNull(data['sourceUrl']);
    if (!sourceUrl) continue;
    switch (data['kind']) {
      case 'fraser':
        if (fraserEnabled) ratings = { ...ratings, fraser: toFraser(data, sourceUrl) };
        break;
      case 'provincial':
        ratings = { ...ratings, provincialResults: toProvincial(data, sourceUrl) };
        break;
      case 'enrolment':
        ratings = { ...ratings, enrolment: toEnrolment(data, sourceUrl) };
        break;
    }
  }
  return ratings;
}

/** Extras attached to a directory school (#776). */
export interface SchoolExtras {
  readonly ratings: SchoolRatings;
  readonly reviews: SchoolReviewsLink | null;
}

/** Stored row → public DTO. Null for a row without a valid type (pre-#774 data). */
export function toSchool(
  row: StoredDirectorySchool,
  extras: SchoolExtras = { ratings: NO_RATINGS, reviews: null },
): School | null {
  if (!isSchoolType(row.schoolType)) return null;
  const data = (typeof row.data === 'object' && row.data !== null ? row.data : {}) as Record<string, unknown>;
  const rawSources = (typeof data['sources'] === 'object' && data['sources'] !== null
    ? data['sources']
    : {}) as Record<string, unknown>;
  const sources: Partial<Record<SchoolAttributedField, SchoolSourceId>> = {};
  for (const [field, source] of Object.entries(rawSources)) {
    if (isSourceId(source)) sources[field as SchoolAttributedField] = source;
  }
  const programs = Array.isArray(data['programs'])
    ? (data['programs'].filter((p) => typeof p === 'string') as SchoolProgram[])
    : [];
  return {
    id: row.externalId,
    name: row.name,
    type: row.schoolType,
    board: row.board,
    authority: strOrNull(data['authority']),
    grades: row.grades,
    programs,
    address: strOrNull(data['address']),
    postalCode: strOrNull(data['postalCode']),
    lat: row.lat,
    lng: row.lng,
    website: strOrNull(data['website']),
    tuition: data['tuition'] === true,
    communityCode: row.communityCode,
    communityName: strOrNull(data['communityName']),
    sources,
    ratings: extras.ratings,
    reviews: extras.reviews,
    refreshedAt: row.refreshedAt.toISOString(),
  };
}

/** Attribution notices for every source used by these schools. */
export function attributionsFor(schools: readonly School[]): SchoolSourceAttribution[] {
  const used = new Set<SchoolSourceId>();
  for (const school of schools) for (const source of Object.values(school.sources)) used.add(source);
  return SOURCE_IDS.filter((id) => used.has(id)).map((id) => ({ id, ...SCHOOL_SOURCE_ATTRIBUTIONS[id] }));
}

export function createSchoolDirectoryReadService(
  deps: SchoolDirectoryReadServiceDeps,
): SchoolDirectoryReadService {
  const { store, fraserEnabled = false, reviewsLink = NO_REVIEWS_LINK } = deps;

  /** Directory rows → DTOs with ratings (one ratings query) + reviews link. */
  async function withExtras(rows: readonly StoredDirectorySchool[]): Promise<School[]> {
    const ratingRows = await store.listSchoolRatings(rows.map((r) => r.externalId));
    const bySchool = new Map<string, StoredSchoolRating[]>();
    for (const r of ratingRows) {
      if (!r.schoolId) continue;
      const list = bySchool.get(r.schoolId) ?? [];
      list.push(r);
      bySchool.set(r.schoolId, list);
    }
    const out: School[] = [];
    for (const row of rows) {
      const data = asRecord(row.data);
      const school = toSchool(row, {
        ratings: toRatings(bySchool.get(row.externalId) ?? [], fraserEnabled),
        reviews: reviewsLink({ name: row.name, address: strOrNull(data['address']) }),
      });
      if (school) out.push(school);
    }
    return out;
  }

  return {
    async listSchools(query): Promise<SchoolDirectoryList> {
      const rows = await store.listSchools({
        ...(query.communityCode ? { communityCode: query.communityCode.trim().toUpperCase() } : {}),
        ...(query.type ? { schoolType: query.type } : {}),
      });
      const schools = await withExtras(rows);
      return { schools, attributions: attributionsFor(schools) };
    },

    async getSchool(id) {
      const row = await store.getSchool(id);
      const [school] = row ? await withExtras([row]) : [];
      return school ? { school, attributions: attributionsFor([school]) } : null;
    },
  };
}
