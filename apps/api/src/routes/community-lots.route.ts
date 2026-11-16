/**
 * Thin community-lots route (#691).
 * Routes are adapters: validate input → call one service method → format.
 *
 * GET /api/v1/communities/{slug}/lots — public, rate-limited, cached.
 * Query: `kind`, `district`, `minLotSqft`, `maxLotSqft`, `sort`
 * (`address` | `lot-size-asc` | `lot-size-desc`), `limit`, `cursor`.
 *
 * The response is built field by field from the contract — no owner name,
 * no per-square-foot figure, nothing beyond `CommunityLotsResponse`
 * (output-hygiene test). `assessedValue` is the City-assessed value.
 *
 * Hard rules (test/boundaries.test.ts): never imports src/db/, never reads
 * process.env, depends on the service interface only.
 */
import { z } from 'zod';
import type { CommunityLot, CommunityLotsResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import {
  InvalidCursorError,
  type CommunityLotsService,
  type StoredCommunityLot,
} from '../services/community-lots.service';

export interface CommunityLotsRouteDeps {
  readonly communityLots: CommunityLotsService;
}

export interface CommunityLotsRoute {
  handle(
    slug: unknown,
    query: Record<string, string | undefined> | undefined,
  ): Promise<CommunityLotsResponse>;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const intParam = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform((v) => Number.parseInt(v, 10));

const QuerySchema = z
  .object({
    kind: z.enum(['vacant', 'candidate']).optional(),
    district: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,20}$/)
      .optional(),
    minLotSqft: intParam.optional(),
    maxLotSqft: intParam.optional(),
    sort: z.enum(['address', 'lot-size-asc', 'lot-size-desc']).default('address'),
    limit: intParam.pipe(z.number().int().positive()).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    (q) => q.minLotSqft === undefined || q.maxLotSqft === undefined || q.minLotSqft <= q.maxLotSqft,
    { message: 'minLotSqft must not exceed maxLotSqft' },
  );

function toWire(lot: StoredCommunityLot): CommunityLot {
  return {
    rollNumber: lot.rollNumber,
    address: lot.address,
    lotSqft: lot.lotSqft,
    assessedValue: lot.assessedValue,
    rollYear: lot.rollYear,
    district: lot.district,
    districtSource: lot.districtSource,
    kind: lot.kind,
    latitude: lot.latitude,
    longitude: lot.longitude,
    firstSeenAt: lot.firstSeenAt.toISOString(),
  };
}

export function createCommunityLotsRoute(deps: CommunityLotsRouteDeps): CommunityLotsRoute {
  return {
    async handle(slug, query) {
      if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid community slug.');
      }
      // Drop empty params (`?district=`) rather than rejecting them.
      const raw = Object.fromEntries(
        Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== ''),
      );
      const parsed = QuerySchema.safeParse(raw);
      if (!parsed.success) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid lot list query.');
      }
      let result;
      try {
        result = await deps.communityLots.list(slug, parsed.data);
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Invalid cursor.');
        }
        throw error;
      }
      if (!result) {
        throw new HttpError(404, ErrorCodes.COMMUNITY_NOT_FOUND, `Unknown community: ${slug}.`);
      }
      return {
        community: { slug: result.community.slug, name: result.community.name },
        city: result.city,
        refreshedAt: result.refreshedAt.toISOString(),
        stale: result.stale,
        total: result.page.total,
        lots: result.page.lots.map(toWire),
        nextCursor: result.page.nextCursor,
      };
    },
  };
}
