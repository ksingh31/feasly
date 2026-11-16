/**
 * Community lots route + read service (#691).
 *
 * AC5 cursor pagination + filters; unknown slug → standard RFC 7807 404
 * envelope; invalid query → 400. AC6 output hygiene: no per-square-foot
 * figure, no owner name, nothing beyond the contract (strict OpenAPI
 * schema). Stale flag from config.
 */
import { describe, expect, it } from 'vitest';
import { createCommunityLotsRoute } from '../src/routes/community-lots.route';
import {
  createCommunityLotsService,
  type CommunityLotsService,
} from '../src/services/community-lots.service';
import type {
  CommunityLotRefreshRecord,
  CommunityLotsStore,
} from '../src/services/community-lots.store';
import type { StoredCommunityLot } from '../src/services/community-lots/lot-rules';
import { ErrorCodes, HttpError, toProblemDetails } from '../src/middleware/errors';
import { CommunityLotsResponseSchema } from '../src/openapi/schemas';

const NOW = new Date('2026-11-16T12:00:00Z');

function stored(roll: string, over: Partial<StoredCommunityLot> = {}): StoredCommunityLot {
  return {
    city: 'calgary',
    communitySlug: 'altadore',
    rollNumber: roll,
    address: `${roll} TEST ST SW`,
    lotSqft: 5000,
    assessedValue: 800_000,
    rollYear: '2026',
    district: 'R-CG',
    districtSource: 'land-use-districts',
    kind: 'vacant',
    latitude: 51.01,
    longitude: -114.1,
    firstSeenAt: new Date('2026-11-09T09:30:00Z'),
    updatedAt: new Date('2026-11-09T09:30:00Z'),
    ...over,
  };
}

function fakeStore(
  lots: StoredCommunityLot[],
  refreshedAt = new Date('2026-11-16T09:30:00Z'),
): CommunityLotsStore {
  const refresh: CommunityLotRefreshRecord = {
    city: 'calgary',
    communitySlug: 'altadore',
    communityName: 'ALTADORE',
    rollYear: '2026',
    lotCount: lots.length,
    refreshedAt,
  };
  return {
    getRefresh: async (city, slug) => (city === 'calgary' && slug === 'altadore' ? refresh : null),
    listLots: async (_city, slug) => (slug === 'altadore' ? lots : []),
    applyCommunity: async () => {},
    removeCommunitiesExcept: async () => 0,
  };
}

const CONFIG = { city: 'calgary', staleAfterDays: 14, defaultLimit: 2, maxLimit: 3 };

function route(lots: StoredCommunityLot[], refreshedAt?: Date) {
  const service: CommunityLotsService = createCommunityLotsService({
    store: fakeStore(lots, refreshedAt),
    config: CONFIG,
    clock: () => NOW,
  });
  return createCommunityLotsRoute({ communityLots: service });
}

async function expectHttpError(p: Promise<unknown>, status: number, code: string) {
  const error = await p.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
  expect((error as HttpError).code).toBe(code);
  return error as HttpError;
}

const LOTS = [
  stored('1', { address: '1 A ST SW', lotSqft: 3000 }),
  stored('2', { address: '2 B ST SW', lotSqft: 9000, district: 'H-GO' }),
  stored('3', { address: '3 C ST SW', lotSqft: 6000 }),
  stored('4', { address: '4 D ST SW', lotSqft: null }),
];

describe('GET /api/v1/communities/{slug}/lots', () => {
  it('returns the first page with the default limit and a cursor to the next', async () => {
    const res = await route(LOTS).handle('altadore', {});
    expect(res).toMatchObject({
      community: { slug: 'altadore', name: 'ALTADORE' },
      city: 'calgary',
      refreshedAt: '2026-11-16T09:30:00.000Z',
      stale: false,
      total: 4,
    });
    expect(res.lots.map((l) => l.rollNumber)).toEqual(['1', '2']);
    expect(res.nextCursor).toEqual(expect.any(String));
    const next = await route(LOTS).handle('altadore', { cursor: res.nextCursor! });
    expect(next.lots.map((l) => l.rollNumber)).toEqual(['3', '4']);
    expect(next.nextCursor).toBeNull();
  });

  it('applies filters, sort and caps the limit', async () => {
    const r = route(LOTS);
    expect((await r.handle('altadore', { district: 'R-CG', limit: '3' })).total).toBe(3);
    const big = await r.handle('altadore', { minLotSqft: '5000', sort: 'lot-size-desc', limit: '3' });
    expect(big.lots.map((l) => l.rollNumber)).toEqual(['2', '3']);
    expect((await r.handle('altadore', { maxLotSqft: '4000' })).lots.map((l) => l.rollNumber)).toEqual(['1']);
    expect((await r.handle('altadore', { kind: 'candidate' })).total).toBe(0);
    // limit above maxLimit is capped
    expect((await r.handle('altadore', { limit: '999' })).lots).toHaveLength(3);
    // empty params are ignored
    expect((await r.handle('altadore', { district: '' })).total).toBe(4);
  });

  it('flags stale when the refresh is older than the configured threshold', async () => {
    const res = await route(LOTS, new Date('2026-10-01T00:00:00Z')).handle('altadore', {});
    expect(res.stale).toBe(true);
  });

  it('unknown slug → standard RFC 7807 404 envelope', async () => {
    const error = await expectHttpError(
      route(LOTS).handle('mahogany', {}),
      404,
      ErrorCodes.COMMUNITY_NOT_FOUND,
    );
    const problem = toProblemDetails(error, 'corr-1');
    expect(problem).toMatchObject({
      status: 404,
      code: ErrorCodes.COMMUNITY_NOT_FOUND,
      correlationId: 'corr-1',
    });
  });

  it.each([
    ['bad slug', 'Not A Slug', {}],
    ['unknown param', 'altadore', { owner: 'x' }],
    ['bad kind', 'altadore', { kind: 'teardown' }],
    ['bad sort', 'altadore', { sort: 'price' }],
    ['non-numeric area', 'altadore', { minLotSqft: '5k' }],
    ['min > max', 'altadore', { minLotSqft: '9000', maxLotSqft: '100' }],
    ['zero limit', 'altadore', { limit: '0' }],
    ['garbage cursor', 'altadore', { cursor: 'zzz' }],
  ])('400 VALIDATION_FAILED for %s', async (_name, slug, query) => {
    await expectHttpError(
      route(LOTS).handle(slug, query as Record<string, string>),
      400,
      ErrorCodes.VALIDATION_FAILED,
    );
  });

  it('AC6 output hygiene: contract fields only — no per-sqft figure, no owner name', async () => {
    // A store row carrying extra (internal) properties must not leak.
    const leaky = { ...stored('9'), ownerName: 'Jane Doe', valuePerSqft: 160, signals: { demo: true } };
    const res = await route([leaky as StoredCommunityLot]).handle('altadore', {});
    // Strict schema: any extra key fails.
    expect(CommunityLotsResponseSchema.safeParse(res).success).toBe(true);
    expect(Object.keys(res.lots[0]).sort()).toEqual(
      [
        'address',
        'assessedValue',
        'district',
        'districtSource',
        'firstSeenAt',
        'kind',
        'latitude',
        'longitude',
        'lotSqft',
        'rollNumber',
        'rollYear',
      ].sort(),
    );
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/owner|per_?sq|persq|sqft_?price|Jane Doe|signals|updatedAt/i);
  });
});
