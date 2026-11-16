/**
 * Thin nearby-permits routes (#822).
 *
 * - GET /api/v1/properties/permits?addressKey=… — residential new-build
 *   building + development permits within the configured radius of an
 *   address: one summary plus a short list (detail on demand in the UI).
 * - GET /api/v1/communities/{slug}/permits — permits per year and median
 *   approval times for an established community (slug or City code).
 *
 * Public and ungated. Served from our tables only (monthly refresh); the
 * read service has no provider access, so a page view never triggers a City
 * permits call. 503 (retryable) until the first monthly load has run.
 *
 * Hard rules (test/boundaries.test.ts): no src/db imports, no process.env,
 * depends on the service interface only.
 */
import type { CommunityPermitsResponse, NearbyPermitsResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type {
  PermitsReadService,
  PermitsUnavailable,
} from '../services/neighbourhood-data/permits-read.service';

export interface PermitsRouteDeps {
  readonly permits: PermitsReadService;
}

export interface PermitsRoute {
  nearby(addressKey: unknown): Promise<NearbyPermitsResponse>;
  community(slug: unknown): Promise<CommunityPermitsResponse>;
}

const MAX_ADDRESS_CHARS = 200;
/** Slug ('altadore', 'killarney-glengarry') or City code ('ALT', '09Q'). */
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const MAX_KEY_LENGTH = 64;

function unavailable(reason: PermitsUnavailable, subject: string): HttpError {
  switch (reason) {
    case 'not-loaded':
      return new HttpError(
        503,
        ErrorCodes.DEPENDENCY_UNAVAILABLE,
        'Permit data has not been loaded yet. Try again later.',
        true,
      );
    case 'no-location':
      return new HttpError(404, ErrorCodes.NOT_FOUND, `No location on record for ${subject}.`, false);
    case 'unknown-community':
      return new HttpError(404, ErrorCodes.COMMUNITY_NOT_FOUND, `Unknown community: ${subject}.`, false);
  }
}

export function createPermitsRoute(deps: PermitsRouteDeps): PermitsRoute {
  return {
    async nearby(addressKey: unknown): Promise<NearbyPermitsResponse> {
      if (typeof addressKey !== 'string' || addressKey.trim().length === 0) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Missing required query parameter: addressKey.', false);
      }
      if (addressKey.trim().length > MAX_ADDRESS_CHARS) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Query parameter addressKey is too long (max ${MAX_ADDRESS_CHARS} characters).`,
          false,
        );
      }
      const result = await deps.permits.getNearbyPermits(addressKey.trim());
      if (!result.ok) throw unavailable(result.reason, 'this address');
      const m = result.value;
      return {
        addressKey: m.addressKey,
        radiusM: m.radiusM,
        sinceYear: m.sinceYear,
        buildingPermits: m.buildingPermits,
        newHomes: m.newHomes,
        developmentPermits: m.developmentPermits,
        typicalDpToBpWeeks: m.typicalDpToBpWeeks,
        total: m.total,
        permits: m.permits.map((p) => ({
          kind: p.kind,
          permitNumber: p.permitNumber,
          address: p.address,
          permitType: p.permitType,
          status: p.status,
          year: p.year,
          builder: p.builder,
          distanceM: p.distanceM,
          recordUrl: p.recordUrl,
        })),
        dataRefreshedAt: m.dataRefreshedAt,
      };
    },

    async community(slug: unknown): Promise<CommunityPermitsResponse> {
      if (typeof slug !== 'string' || slug.length === 0 || slug.length > MAX_KEY_LENGTH || !KEY_RE.test(slug)) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid community slug.', false);
      }
      const result = await deps.permits.getCommunityPermits(slug);
      if (!result.ok) throw unavailable(result.reason, slug);
      const m = result.value;
      return {
        communityCode: m.communityCode,
        name: m.name,
        slug: m.slug,
        perYear: m.perYear.map((y) => ({
          year: y.year,
          buildingPermits: y.buildingPermits,
          newHomes: y.newHomes,
          developmentPermits: y.developmentPermits,
        })),
        sinceYear: m.sinceYear,
        medianApprovalWeeks: {
          buildingPermit: m.medianApprovalWeeks.buildingPermit,
          developmentPermit: m.medianApprovalWeeks.developmentPermit,
          dpToBp: m.medianApprovalWeeks.dpToBp,
        },
        dataRefreshedAt: m.dataRefreshedAt,
      };
    },
  };
}
