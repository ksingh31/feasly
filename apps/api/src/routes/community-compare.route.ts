/**
 * Thin community compare route (#780, Community Match epic).
 *
 * - GET /api/v1/communities/compare?slugs=a,b[,c] — public and ungated.
 *   2 to `compareMax` (config) established communities by slug, side by
 *   side: schools, amenities, tree cover and building-here rows, each with
 *   the row's best value marked by the service.
 * - Built from the precomputed match snapshot only; the service has no
 *   provider access, so a visitor never triggers an outside call.
 *
 * Hard rules (test/boundaries.test.ts): no src/db imports, no process.env,
 * depends on the service interface only.
 */
import { z } from 'zod';
import type { CommunityCompareResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import {
  UnknownCommunityError,
  type CommunityMatchService,
} from '../services/community-match/community-match.service';

export interface CommunityCompareRouteDeps {
  readonly communityMatch: Pick<CommunityMatchService, 'compare'>;
  /** Most communities per request (config `communityMatch.compareMax`). */
  readonly compareMax: number;
}

export interface CommunityCompareRoute {
  handle(query: Record<string, string | undefined> | undefined): Promise<CommunityCompareResponse>;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Hard ceiling on the raw query value (the real cap is compareMax). */
const MAX_QUERY_LENGTH = 1_000;

export function createCommunityCompareRoute(deps: CommunityCompareRouteDeps): CommunityCompareRoute {
  const QuerySchema = z
    .string()
    .max(MAX_QUERY_LENGTH)
    .transform((raw) => raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
    .pipe(
      z
        .array(z.string().max(100).regex(SLUG, 'must be kebab-case community slugs'))
        .min(2, 'compare at least 2 communities')
        .max(deps.compareMax, `compare at most ${deps.compareMax} communities`)
        .refine((list) => new Set(list).size === list.length, 'slugs must be unique'),
    );

  return {
    async handle(query) {
      const parsed = QuerySchema.safeParse(query?.['slugs'] ?? '');
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Invalid compare request (slugs: ${parsed.error.issues[0]?.message ?? 'invalid'}).`,
        );
      }
      try {
        return await deps.communityMatch.compare(parsed.data);
      } catch (error) {
        if (error instanceof UnknownCommunityError) {
          throw new HttpError(404, ErrorCodes.COMMUNITY_NOT_FOUND, `Unknown community: ${error.slugs.join(', ')}.`);
        }
        throw error;
      }
    },
  };
}
