/**
 * School designation reads (#775) — the request-path side.
 *
 * Serves ONLY from the `school_designations` table (monthly refresh). No
 * provider dependency, so a visitor never triggers an outside call. An
 * address is resolved to its community through the property lookup, which
 * reads the shared property cache (#756) first.
 *
 * Established infill communities only (#690): a community is known when it
 * has an anchor row (the same rule as GET /communities/{slug}/living).
 *
 * Every designation is labelled "typically designated" and every response
 * carries each board's address lookup link.
 */
import {
  DESIGNATION_GRADE_BANDS,
  SCHOOL_BOARD_IDS,
  TYPICALLY_DESIGNATED,
  type AddressSchoolDesignationsResponse,
  type CommunitySchoolDesignationsResponse,
  type DesignationGradeBand,
  type SchoolBoardId,
  type SchoolBoardLookup,
  type SchoolDesignation,
} from '@feasly/contracts';
import { SCHOOL_BOARD_NAMES, SCHOOL_DESIGNATIONS_DISCLAIMER } from '../../lib/school-boards';
import { toSlug } from '../community-stats/socrata-aggregates';
import type { PropertyService } from '../property.service';
import type { NeighbourhoodDataStore, StoredCommunityAnchor, StoredDesignation } from './neighbourhood-data.store';

export interface SchoolDesignationReadService {
  /** By community slug or City code; null when the community is not covered. */
  forCommunity(slugOrCode: string): Promise<CommunitySchoolDesignationsResponse | null>;
  /**
   * Via the address's community. Always answers (empty designations when the
   * community is unknown or not covered).
   * @throws HttpError 404/503 from the property lookup.
   */
  forAddress(addressKey: string): Promise<AddressSchoolDesignationsResponse>;
}

export interface SchoolDesignationReadServiceDeps {
  readonly store: Pick<NeighbourhoodDataStore, 'communityAnchor' | 'listDesignations'>;
  readonly properties: Pick<PropertyService, 'getProperty'>;
  /** From config: each board's address lookup page. */
  readonly lookupUrls: Readonly<Record<SchoolBoardId, string>>;
}

function str(data: unknown, key: string): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isBoard(value: unknown): value is SchoolBoardId {
  return typeof value === 'string' && (SCHOOL_BOARD_IDS as readonly string[]).includes(value);
}

function isBand(value: unknown): value is DesignationGradeBand {
  return typeof value === 'string' && (DESIGNATION_GRADE_BANDS as readonly string[]).includes(value);
}

export function createSchoolDesignationReadService(
  deps: SchoolDesignationReadServiceDeps,
): SchoolDesignationReadService {
  const { store, properties, lookupUrls } = deps;

  const boards: SchoolBoardLookup[] = SCHOOL_BOARD_IDS.map((board) => ({
    board,
    name: SCHOOL_BOARD_NAMES[board],
    lookupUrl: lookupUrls[board],
  }));

  /** Stored row → DTO; null for a row that does not parse. */
  function toDesignation(row: StoredDesignation): SchoolDesignation | null {
    const board = str(row.data, 'board');
    const schoolName = str(row.data, 'schoolName');
    if (!isBoard(board) || !isBand(row.gradeBand) || !schoolName) return null;
    return {
      board,
      boardName: SCHOOL_BOARD_NAMES[board],
      gradeBand: row.gradeBand,
      schoolName,
      label: TYPICALLY_DESIGNATED,
      lookupUrl: lookupUrls[board],
      refreshedAt: row.refreshedAt.toISOString(),
    };
  }

  /** Board order, then grade-band order. */
  async function designationsFor(communityCode: string): Promise<SchoolDesignation[]> {
    const rows = await store.listDesignations(communityCode);
    return rows
      .map(toDesignation)
      .filter((d): d is SchoolDesignation => d !== null)
      .sort(
        (a, b) =>
          SCHOOL_BOARD_IDS.indexOf(a.board) - SCHOOL_BOARD_IDS.indexOf(b.board) ||
          DESIGNATION_GRADE_BANDS.indexOf(a.gradeBand) - DESIGNATION_GRADE_BANDS.indexOf(b.gradeBand),
      );
  }

  function slugOf(anchor: StoredCommunityAnchor): string {
    return str(anchor.data, 'slug') ?? toSlug(anchor.name);
  }

  const base = {
    label: TYPICALLY_DESIGNATED,
    boards,
    disclaimer: SCHOOL_DESIGNATIONS_DISCLAIMER,
  } as const;

  return {
    async forCommunity(slugOrCode) {
      const anchor = await store.communityAnchor(slugOrCode);
      if (!anchor) return null;
      return {
        ...base,
        communityCode: anchor.communityCode,
        communityName: anchor.name,
        slug: slugOf(anchor),
        designations: await designationsFor(anchor.communityCode),
      };
    },

    async forAddress(addressKey) {
      const property = await properties.getProperty(addressKey);
      const name = property.community?.trim() ?? '';
      // PropertyService answers 'Calgary' when the City row has no community.
      const known = name.length > 0 && name.toLowerCase() !== 'calgary';
      const anchor = known ? await store.communityAnchor(toSlug(name)) : null;
      return {
        ...base,
        addressKey,
        communityCode: anchor?.communityCode ?? null,
        communityName: anchor?.name ?? (known ? name : null),
        slug: anchor ? slugOf(anchor) : known ? toSlug(name) : null,
        designations: anchor ? await designationsFor(anchor.communityCode) : [],
      };
    },
  };
}
