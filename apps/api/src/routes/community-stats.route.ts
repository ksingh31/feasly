/**
 * Thin community-stats route (neighbourhood/01).
 * Routes are adapters, not logic: validate input → call exactly one service
 * method → return the result.
 *
 * - GET /api/v1/communities/{slug}/stats — public, cache-first. The response
 *   carries `refreshed_at` and a `stale` flag (true when the row is older
 *   than {@link STALE_AFTER_DAYS} days — never silently stale).
 * - `avg_assessed_value` is a whole-dollar **City-assessed value (not market
 *   value)**. The serialized response contains no raw Socrata internals
 *   (see the deny-list test).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { CommunityStatsService } from '../services/community-stats.service';

export interface CommunityStatsRouteDeps {
  readonly communityStats: CommunityStatsService;
}

/** Row is stale when it has not been refreshed within this many days. */
export const STALE_AFTER_DAYS = 45;

/** Serialized response — snake_case, no Socrata internals. */
export interface CommunityStatsResponse {
  readonly slug: string;
  readonly name: string;
  /** Whole CAD dollars — City-assessed value (not market value). */
  readonly avg_assessed_value: number;
  readonly assessment_count: number;
  readonly avg_lot_sqft: number | null;
  readonly refreshed_at: string;
  readonly stale: boolean;
}

export interface CommunityStatsRoute {
  /** Stats for one community slug; 404 when the slug is unknown. */
  handle(slug: unknown): Promise<CommunityStatsResponse>;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createCommunityStatsRoute(
  deps: CommunityStatsRouteDeps,
): CommunityStatsRoute {
  return {
    handle: async (slug: unknown): Promise<CommunityStatsResponse> => {
      if (typeof slug !== 'string' || slug.length === 0 || !SLUG_RE.test(slug)) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid community slug.',
        );
      }
      const record = await deps.communityStats.getBySlug(slug);
      if (!record) {
        throw new HttpError(
          404,
          ErrorCodes.COMMUNITY_NOT_FOUND,
          `Unknown community: ${slug}.`,
        );
      }
      const stale =
        record.refreshedAt.getTime() <
        Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
      return {
        slug: record.slug,
        name: record.name,
        avg_assessed_value: record.avgAssessedValue,
        assessment_count: record.assessmentCount,
        avg_lot_sqft: record.avgLotSqft,
        refreshed_at: record.refreshedAt.toISOString(),
        stale,
      };
    },
  };
}
