/**
 * Thin schools directory route (#774, Community Match epic).
 *
 * - GET /api/v1/schools?community=&type= — public, free, ungated. Every
 *   Calgary K–12 school the monthly refresh stored, optionally filtered by
 *   City community code and/or school type (AND). Name order.
 * - GET /api/v1/schools/{id} — one school; 404 when the id is unknown.
 *
 * Both answer from our tables only (no outside call on a request) and carry
 * per-field source attribution plus the source notices.
 *
 * Hard rules (enforced by test/boundaries.test.ts): no db/, no process.env,
 * depends on the service interface only.
 */
import { SCHOOL_TYPES, type SchoolResponse, type SchoolsListResponse, type SchoolType } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import {
  SCHOOLS_DISCLAIMER,
  type SchoolDirectoryReadService,
} from '../services/neighbourhood-data/school-directory-read.service';

export interface SchoolsRouteDeps {
  readonly schools: SchoolDirectoryReadService;
}

export interface SchoolsRoute {
  list(query: Record<string, string | undefined> | undefined): Promise<SchoolsListResponse>;
  get(id: unknown): Promise<SchoolResponse>;
}

/** City community codes: 2–5 letters/digits (e.g. 'ALT', 'MRL', '01B'). */
const COMMUNITY_RE = /^[A-Za-z0-9]{2,5}$/;
/** Directory ids: `city-<guid>` or `osm-<type>-<id>`. */
const ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;

function invalid(message: string): HttpError {
  return new HttpError(400, ErrorCodes.VALIDATION_FAILED, message);
}

export function createSchoolsRoute(deps: SchoolsRouteDeps): SchoolsRoute {
  return {
    async list(query): Promise<SchoolsListResponse> {
      const community = query?.['community']?.trim() || undefined;
      const type = query?.['type']?.trim() || undefined;
      if (community !== undefined && !COMMUNITY_RE.test(community)) {
        throw invalid('community must be a City community code, e.g. ALT.');
      }
      if (type !== undefined && !(SCHOOL_TYPES as readonly string[]).includes(type)) {
        throw invalid(`type must be one of: ${SCHOOL_TYPES.join(', ')}.`);
      }
      const result = await deps.schools.listSchools({
        ...(community ? { communityCode: community } : {}),
        ...(type ? { type: type as SchoolType } : {}),
      });
      return { ...result, disclaimer: SCHOOLS_DISCLAIMER };
    },

    async get(id): Promise<SchoolResponse> {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw invalid('Invalid school id.');
      const found = await deps.schools.getSchool(id);
      if (!found) throw new HttpError(404, ErrorCodes.NOT_FOUND, 'School not found.');
      return { ...found, disclaimer: SCHOOLS_DISCLAIMER };
    },
  };
}
