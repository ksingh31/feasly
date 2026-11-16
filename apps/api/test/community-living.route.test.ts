/**
 * Community living-nearby route (#777): contract shape, 404 for communities
 * without an anchor (non-established, #690), 400 on malformed keys, no
 * dollar figures and no internal fields on the wire.
 */
import { describe, expect, it } from 'vitest';
import { createCommunityLivingRoute } from '../src/routes/community-living.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { CommunityLivingMetrics } from '../src/services/neighbourhood-data/neighbourhood-read.service';

const METRICS: CommunityLivingMetrics = {
  communityCode: 'ALT',
  name: 'ALTADORE',
  slug: 'altadore',
  searchRadiusM: 3_000,
  amenities: [
    {
      category: 'parks',
      label: 'Parks',
      nearest: { name: 'River Park', distanceM: 310 },
      counts: [
        { radiusM: 500, count: 1 },
        { radiusM: 1_000, count: 4 },
      ],
    },
    { category: 'off-leash', label: 'Off-leash areas', nearest: null, counts: [{ radiusM: 500, count: 0 }] },
  ],
  treeCover: { publicTrees: 2000, areaHa: 100, treesPerHa: 20, level: 'high' },
  dataRefreshedAt: '2026-11-01T07:00:00.000Z',
  metrics: { commute: { source: 'straight-line', data: { internal: true } } },
};

function routeWith(metrics: CommunityLivingMetrics, seen: string[] = []) {
  return createCommunityLivingRoute({
    neighbourhood: {
      getCommunityLivingMetrics: async (key: string) => {
        seen.push(key);
        return metrics;
      },
    },
  });
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

describe('community living route (#777)', () => {
  it('serialises every community metric (nearest, 500 m / 1 km counts, tree cover)', async () => {
    const seen: string[] = [];
    const res = await routeWith(METRICS, seen).handle('altadore');
    expect(seen).toEqual(['altadore']);
    expect(res).toEqual({
      communityCode: 'ALT',
      name: 'ALTADORE',
      slug: 'altadore',
      distanceBasis: 'straight-line',
      searchRadiusM: 3_000,
      amenities: METRICS.amenities,
      treeCover: METRICS.treeCover,
      dataRefreshedAt: '2026-11-01T07:00:00.000Z',
    });
    // Internal per-provider metrics never reach the wire; no dollar figures.
    const wire = JSON.stringify(res);
    expect(wire).not.toMatch(/internal|source|\$/);
  });

  it('accepts a City community code too', async () => {
    await expect(routeWith(METRICS).handle('ALT')).resolves.toMatchObject({ slug: 'altadore' });
  });

  it('404 COMMUNITY_NOT_FOUND when the community has no anchor (non-established or unknown)', async () => {
    const err = await problemOf(
      routeWith({ ...METRICS, name: null, slug: null, dataRefreshedAt: null, amenities: [], treeCover: null })
        .handle('cranston'),
    );
    expect(err.status).toBe(404);
    expect(err.code).toBe(ErrorCodes.COMMUNITY_NOT_FOUND);
  });

  it.each([undefined, '', 'a b', '../etc', 'x'.repeat(65), '-alt', 42])('400 on malformed key %s', async (key) => {
    const err = await problemOf(routeWith(METRICS).handle(key));
    expect(err.status).toBe(400);
    expect(err.code).toBe(ErrorCodes.VALIDATION_FAILED);
  });
});
