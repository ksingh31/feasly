/**
 * Nearby permits routes (#822): contract shape, input validation, and the
 * unavailable reasons → 503 (not loaded yet, retryable) / 404.
 */
import { describe, expect, it } from 'vitest';
import { createPermitsRoute } from '../src/routes/permits.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type {
  CommunityPermits,
  NearbyPermits,
  PermitsReadService,
  PermitsResult,
} from '../src/services/neighbourhood-data/permits-read.service';

const NEARBY: NearbyPermits = {
  addressKey: '4500 16 ST SW',
  radiusM: 300,
  sinceYear: 2024,
  buildingPermits: 3,
  newHomes: 4,
  developmentPermits: 2,
  typicalDpToBpWeeks: 39,
  total: 1,
  permits: [
    {
      kind: 'building',
      permitNumber: 'BP2025-00001',
      address: '4504 16 ST SW',
      permitType: 'Two Family',
      status: 'Issued Permit',
      year: 2025,
      builder: 'ACME HOMES LTD',
      distanceM: 100,
      recordUrl: 'https://dmap.calgary.ca/?find=BP2025-00001',
    },
  ],
  dataRefreshedAt: '2026-11-01T07:00:00.000Z',
};

const COMMUNITY: CommunityPermits = {
  communityCode: 'ALT',
  name: 'ALTADORE',
  slug: 'altadore',
  perYear: [{ year: 2026, buildingPermits: 1, newHomes: 1, developmentPermits: 0 }],
  sinceYear: 2024,
  medianApprovalWeeks: { buildingPermit: 13, developmentPermit: null, dpToBp: 39 },
  dataRefreshedAt: '2026-11-01T07:00:00.000Z',
};

function routeWith(
  nearby: PermitsResult<NearbyPermits>,
  community: PermitsResult<CommunityPermits>,
  seen: string[] = [],
) {
  const permits: PermitsReadService = {
    getNearbyPermits: async (key) => {
      seen.push(key);
      return nearby;
    },
    getCommunityPermits: async (key) => {
      seen.push(key);
      return community;
    },
  };
  return createPermitsRoute({ permits });
}

async function problemOf(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected an HttpError');
}

const OK = { nearby: { ok: true, value: NEARBY } as const, community: { ok: true, value: COMMUNITY } as const };

describe('permits routes (#822)', () => {
  it('nearby: serializes the contract shape for a trimmed address key', async () => {
    const seen: string[] = [];
    const route = routeWith(OK.nearby, OK.community, seen);
    expect(await route.nearby('  4500 16 ST SW ')).toEqual(NEARBY);
    expect(seen).toEqual(['4500 16 ST SW']);
  });

  it('community: serializes the contract shape', async () => {
    expect(await routeWith(OK.nearby, OK.community).community('altadore')).toEqual(COMMUNITY);
  });

  it('400 on a missing / oversized address key or a malformed slug', async () => {
    const route = routeWith(OK.nearby, OK.community);
    for (const bad of [undefined, '', '   ', 'x'.repeat(201)]) {
      const error = await problemOf(route.nearby(bad));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    }
    for (const bad of [undefined, '', 'a/b', '../x', 'x'.repeat(65)]) {
      expect((await problemOf(route.community(bad))).status).toBe(400);
    }
  });

  it('503 retryable before the first monthly load; 404 for an unknown community or a parcel without a location', async () => {
    const notLoaded = routeWith({ ok: false, reason: 'not-loaded' }, { ok: false, reason: 'not-loaded' });
    const a = await problemOf(notLoaded.nearby('4500 16 ST SW'));
    expect([a.status, a.code, a.retryable]).toEqual([503, ErrorCodes.DEPENDENCY_UNAVAILABLE, true]);
    expect((await problemOf(notLoaded.community('altadore'))).status).toBe(503);

    const missing = routeWith({ ok: false, reason: 'no-location' }, { ok: false, reason: 'unknown-community' });
    expect((await problemOf(missing.nearby('4500 16 ST SW'))).code).toBe(ErrorCodes.NOT_FOUND);
    const c = await problemOf(missing.community('nowhere'));
    expect([c.status, c.code]).toEqual([404, ErrorCodes.COMMUNITY_NOT_FOUND]);
  });

  it('never returns a dollar figure', async () => {
    const route = routeWith(OK.nearby, OK.community);
    const body = JSON.stringify([await route.nearby('4500 16 ST SW'), await route.community('alt')]);
    expect(body).not.toMatch(/\$|cost|price|value/i);
  });
});
