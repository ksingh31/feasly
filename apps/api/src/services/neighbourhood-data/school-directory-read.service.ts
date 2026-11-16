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
  SCHOOL_TYPES,
  type School,
  type SchoolAttributedField,
  type SchoolProgram,
  type SchoolSourceAttribution,
  type SchoolSourceId,
  type SchoolType,
} from '@feasly/contracts';
import type { NeighbourhoodDataStore, StoredDirectorySchool } from './neighbourhood-data.store';
import { SCHOOL_SOURCE_ATTRIBUTIONS } from '../../lib/school-sources';

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
  readonly store: Pick<NeighbourhoodDataStore, 'listSchools' | 'getSchool'>;
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

/** Stored row → public DTO. Null for a row without a valid type (pre-#774 data). */
export function toSchool(row: StoredDirectorySchool): School | null {
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
  const { store } = deps;
  return {
    async listSchools(query): Promise<SchoolDirectoryList> {
      const rows = await store.listSchools({
        ...(query.communityCode ? { communityCode: query.communityCode.trim().toUpperCase() } : {}),
        ...(query.type ? { schoolType: query.type } : {}),
      });
      const schools = rows.map(toSchool).filter((s): s is School => s !== null);
      return { schools, attributions: attributionsFor(schools) };
    },

    async getSchool(id) {
      const row = await store.getSchool(id);
      const school = row ? toSchool(row) : null;
      return school ? { school, attributions: attributionsFor([school]) } : null;
    },
  };
}
