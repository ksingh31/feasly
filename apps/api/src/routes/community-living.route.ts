/**
 * Thin community "living nearby" route (#777, Community Match epic).
 *
 * - GET /api/v1/communities/{slug}/living — public and ungated. `slug` is
 *   the community page slug ('altadore') or the City community code ('ALT').
 * - Served from our tables only (monthly refresh); the read service has no
 *   provider access, so a visitor never triggers an outside call.
 * - Established infill communities only (#690): any other community has no
 *   anchor row and answers 404.
 *
 * Hard rules (test/boundaries.test.ts): no src/db imports, no process.env,
 * depends on the service interface only.
 */
import type { CommunityLivingResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { NeighbourhoodReadService } from '../services/neighbourhood-data/neighbourhood-read.service';

export interface CommunityLivingRouteDeps {
  readonly neighbourhood: Pick<NeighbourhoodReadService, 'getCommunityLivingMetrics'>;
}

export interface CommunityLivingRoute {
  handle(slug: unknown): Promise<CommunityLivingResponse>;
}

/** Slug ('altadore', 'killarney-glengarry') or City code ('ALT', '09Q'). */
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const MAX_KEY_LENGTH = 64;

export function createCommunityLivingRoute(deps: CommunityLivingRouteDeps): CommunityLivingRoute {
  return {
    async handle(slug: unknown): Promise<CommunityLivingResponse> {
      if (typeof slug !== 'string' || slug.length === 0 || slug.length > MAX_KEY_LENGTH || !KEY_RE.test(slug)) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid community slug.');
      }
      const m = await deps.neighbourhood.getCommunityLivingMetrics(slug);
      if (m.name === null || m.slug === null || m.dataRefreshedAt === null) {
        throw new HttpError(404, ErrorCodes.COMMUNITY_NOT_FOUND, `Unknown community: ${slug}.`);
      }
      return {
        communityCode: m.communityCode,
        name: m.name,
        slug: m.slug,
        distanceBasis: 'straight-line',
        searchRadiusM: m.searchRadiusM,
        amenities: m.amenities.map((a) => ({
          category: a.category,
          label: a.label,
          nearest: a.nearest ? { name: a.nearest.name, distanceM: a.nearest.distanceM } : null,
          counts: a.counts.map((c) => ({ radiusM: c.radiusM, count: c.count })),
        })),
        treeCover: m.treeCover
          ? {
              publicTrees: m.treeCover.publicTrees,
              areaHa: m.treeCover.areaHa,
              treesPerHa: m.treeCover.treesPerHa,
              level: m.treeCover.level,
            }
          : null,
        dataRefreshedAt: m.dataRefreshedAt,
      };
    },
  };
}
