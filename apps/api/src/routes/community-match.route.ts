/**
 * Thin community match route (#778, Community Match epic).
 *
 * - POST /api/v1/communities/match — public and ungated. Body: priorities
 *   (each 'must' or 'nice'), optional filters (minFrontageFt,
 *   lotsListedNow) and limit. Answers established infill communities ranked
 *   by a deterministic 0–100 match.
 * - Scored from precomputed metrics only; the service has no provider
 *   access, so a visitor never triggers an outside call.
 *
 * Hard rules (test/boundaries.test.ts): no src/db imports, no process.env,
 * depends on the service interface only.
 */
import { z } from 'zod';
import type { CommunityMatchResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import {
  UnknownPriorityError,
  type CommunityMatchService,
} from '../services/community-match/community-match.service';

export interface CommunityMatchRouteDeps {
  readonly communityMatch: Pick<CommunityMatchService, 'match' | 'priorities'>;
}

export interface CommunityMatchRoute {
  handle(body: unknown): Promise<CommunityMatchResponse>;
}

/** Hard ceilings on an untrusted body (the real keys come from config). */
const MAX_PRIORITIES = 20;
const MAX_FRONTAGE_FT = 1_000;
const MAX_LIMIT = 1_000;

const BodySchema = z
  .object({
    priorities: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
            importance: z.enum(['must', 'nice']),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PRIORITIES)
      .refine((list) => new Set(list.map((p) => p.key)).size === list.length, 'priority keys must be unique'),
    filters: z
      .object({
        minFrontageFt: z.number().positive().max(MAX_FRONTAGE_FT).optional(),
        lotsListedNow: z.boolean().optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  })
  .strict();

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

export function createCommunityMatchRoute(deps: CommunityMatchRouteDeps): CommunityMatchRoute {
  return {
    async handle(body: unknown): Promise<CommunityMatchResponse> {
      const parsed = BodySchema.safeParse(parseBody(body));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Invalid match request (${where}${issue?.message ?? 'invalid'}).`,
        );
      }
      try {
        return await deps.communityMatch.match(parsed.data);
      } catch (error) {
        if (error instanceof UnknownPriorityError) {
          const known = deps.communityMatch.priorities().map((p) => p.key);
          throw new HttpError(
            400,
            ErrorCodes.VALIDATION_FAILED,
            `Unknown priority: ${error.keys.join(', ')}. Known priorities: ${known.join(', ')}.`,
          );
        }
        throw error;
      }
    },
  };
}
