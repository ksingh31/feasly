/**
 * Thin school designations route (#775, Community Match epic).
 *
 * - GET /api/v1/communities/{slug}/school-designations — public, free,
 *   ungated. CBE + CCSD typically designated schools per grade band for an
 *   established community (slug 'altadore' or City code 'ALT'); 404 when the
 *   community is not covered.
 * - GET /api/v1/school-designations?addressKey= — the same, via the
 *   address's community. Always labelled "typically designated", always with
 *   each board's address lookup link (also when nothing is stored).
 *
 * Both read our tables only (no outside call on a request).
 *
 * Hard rules (test/boundaries.test.ts): no db/, no process.env, depends on
 * the service interface only.
 */
import type {
  AddressSchoolDesignationsResponse,
  CommunitySchoolDesignationsResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { SchoolDesignationReadService } from '../services/neighbourhood-data/school-designation-read.service';

export interface SchoolDesignationsRouteDeps {
  readonly designations: SchoolDesignationReadService;
}

export interface SchoolDesignationsRoute {
  community(slug: unknown): Promise<CommunitySchoolDesignationsResponse>;
  address(query: Record<string, string | undefined> | undefined): Promise<AddressSchoolDesignationsResponse>;
}

/** Slug ('altadore', 'killarney-glengarry') or City code ('ALT', '09Q'). */
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const MAX_KEY_LENGTH = 64;
const MAX_ADDRESS_KEY_LENGTH = 200;

function invalid(message: string): HttpError {
  return new HttpError(400, ErrorCodes.VALIDATION_FAILED, message);
}

export function createSchoolDesignationsRoute(deps: SchoolDesignationsRouteDeps): SchoolDesignationsRoute {
  return {
    async community(slug): Promise<CommunitySchoolDesignationsResponse> {
      if (typeof slug !== 'string' || slug.length === 0 || slug.length > MAX_KEY_LENGTH || !KEY_RE.test(slug)) {
        throw invalid('Invalid community slug.');
      }
      const result = await deps.designations.forCommunity(slug);
      if (!result) throw new HttpError(404, ErrorCodes.COMMUNITY_NOT_FOUND, `Unknown community: ${slug}.`);
      return result;
    },

    async address(query): Promise<AddressSchoolDesignationsResponse> {
      const addressKey = query?.['addressKey']?.trim();
      if (!addressKey) throw invalid('Missing required query parameter: addressKey.');
      if (addressKey.length > MAX_ADDRESS_KEY_LENGTH) {
        throw invalid(`Query parameter addressKey is too long (max ${MAX_ADDRESS_KEY_LENGTH} characters).`);
      }
      return deps.designations.forAddress(addressKey);
    },
  };
}
