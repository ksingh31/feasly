/**
 * Tests for the NBH-02 neighbourhood comparison endpoint.
 * Uses a real CommunityStatsService backed by PGlite (seeded) — no mocks
 * for the stats lookup itself.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createEstimateService } from '../src/services/estimate.service';
import { createDrizzleCommunityStatsService } from '../src/services/community-stats.service';
import { PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { HttpError } from '../src/middleware/errors';
import type { EstimateStore, EstimateRecord } from '../src/services/estimate-store.interface';
import { createTestDb, type TestDb } from './pglite-db';
import { communityStats } from '../src/db/schema';

function fakeStore() {
  const byId = new Map<string, EstimateRecord>();
  const saved: EstimateRecord[] = [];
  return {
    saved,
    save: async (record: EstimateRecord) => {
      byId.set(record.id, record);
      saved.push(record);
    },
    findById: async (id: string) => byId.get(id) ?? null,
  };
}

describe('estimate service — comparison (NBH-02)', () => {
  let testDb: TestDb;
  let store: ReturnType<typeof fakeStore>;

  beforeEach(async () => {
    testDb = await createTestDb();
    store = fakeStore();
    // Seed community_stats with two communities.
    await testDb.db.insert(communityStats).values([
      {
        slug: 'community-a',
        name: 'Community A',
        avgAssessedValue: 500000,
        assessmentCount: 100,
        avgLotSqft: 5000,
        refreshedAt: new Date(),
      },
      {
        slug: 'community-b',
        name: 'Community B',
        avgAssessedValue: 600000,
        assessmentCount: 120,
        avgLotSqft: 6000,
        refreshedAt: new Date(),
      },
      {
        slug: 'community-c',
        name: 'Community C',
        avgAssessedValue: 550000,
        assessmentCount: 90,
        avgLotSqft: null, // no lot size data
        refreshedAt: new Date(),
      },
    ]);
  }, 30000); // PGlite setup + migrations can take >10s

  function createService() {
    const communityStatsService = createDrizzleCommunityStatsService({ db: testDb.db });
    return createEstimateService({
      costData: PLACEHOLDER_COST_DATA,
      store,
      allowDraftCostData: true,
      communityStats: communityStatsService,
    });
  }

  it('returns comparison response for 2 neighbourhoods', async () => {
    const service = createService();
    const result = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a', 'community-b'],
      sqft: 2000,
      tier: 'standard',
    });

    // Must be a comparison response (has projectType: 'comparison')
    expect(result.projectType).toBe('comparison');
    if (result.projectType !== 'comparison') throw new Error('Expected comparison');

    expect(result.rowSets.map((rs) => rs.slug)).toEqual(['community-a', 'community-b']);
    expect(result.rowSets).toHaveLength(2);
    expect(result.costDataVersion).toBe('v0.3.0-unclibrated');

    // Exactly one lowestLand
    const lowest = result.rowSets.filter((rs) => rs.lowestLand);
    expect(lowest).toHaveLength(1);
    // community-a has smaller lot (5000 vs 6000) → cheaper land
    expect(lowest[0].slug).toBe('community-a');

    // Componentwise sums
    for (const rs of result.rowSets) {
      expect(rs.total.low).toBe(rs.land.low + rs.build.low);
      expect(rs.total.base).toBe(rs.land.base + rs.build.base);
      expect(rs.total.high).toBe(rs.land.high + rs.build.high);
    }

    // Visibility: land visible, build/total blurred
    for (const rs of result.rowSets) {
      expect(rs.visibility).toEqual({
        land: 'visible',
        build: 'blurred',
        total: 'blurred',
      });
    }

    // No per-sqft rates or margins in response
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/per.?sqft/i);
    expect(json).not.toMatch(/landRatePerSqft/);
    expect(json).not.toMatch(/margin/i);
  });

  it('returns comparison response for 3 neighbourhoods', async () => {
    const service = createService();
    // Add a third community with lot size
    await testDb.db.insert(communityStats).values({
      slug: 'community-d',
      name: 'Community D',
      avgAssessedValue: 520000,
      assessmentCount: 110,
      avgLotSqft: 5500,
      refreshedAt: new Date(),
    });

    const result = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a', 'community-b', 'community-d'],
      sqft: 2000,
      tier: 'standard',
    });

    expect(result.projectType).toBe('comparison');
    if (result.projectType !== 'comparison') throw new Error('Expected comparison');
    expect(result.rowSets).toHaveLength(3);
  });

  it('rejects unknown slug with 422 COMMUNITY_NOT_FOUND', async () => {
    const service = createService();
    const error = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a', 'unknown-slug'],
      sqft: 2000,
      tier: 'standard',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('COMMUNITY_NOT_FOUND');
  });

  it('rejects 1 neighbourhood with 422 naming neighbourhoods', async () => {
    const service = createService();
    const error = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a'],
      sqft: 2000,
      tier: 'standard',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    // Error should mention the neighbourhoods field
    expect(error.message).toMatch(/neighbourhoods/i);
  });

  it('rejects 4 neighbourhoods with 422', async () => {
    const service = createService();
    const error = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a', 'community-b', 'community-a', 'community-b'],
      sqft: 2000,
      tier: 'standard',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
  });

  it('rejects community with null avgLotSqft', async () => {
    const service = createService();
    const error = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a', 'community-c'], // community-c has null lot size
      sqft: 2000,
      tier: 'standard',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('COMMUNITY_NOT_FOUND');
  });

  it('persists immutable estimate with project_type=comparison', async () => {
    const service = createService();
    const result = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a', 'community-b'],
      sqft: 2000,
      tier: 'standard',
    });

    expect(result.projectType).toBe('comparison');
    if (result.projectType !== 'comparison') throw new Error('Expected comparison');

    // Verify it was saved
    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    expect(saved.projectType).toBe('comparison');
    expect(saved.id).toBe(result.estimateId);
  });

  it('tie goes to first slug (deterministic)', async () => {
    const service = createService();
    // community-a and community-e have same lot size
    await testDb.db.insert(communityStats).values({
      slug: 'community-e',
      name: 'Community E',
      avgAssessedValue: 510000,
      assessmentCount: 95,
      avgLotSqft: 5000, // same as community-a
      refreshedAt: new Date(),
    });

    const result = await service.estimate({
      projectType: 'comparison',
      neighbourhoods: ['community-a', 'community-e'],
      sqft: 2000,
      tier: 'standard',
    });

    expect(result.projectType).toBe('comparison');
    if (result.projectType !== 'comparison') throw new Error('Expected comparison');

    const first = result.rowSets.find((rs) => rs.slug === 'community-a')!;
    const second = result.rowSets.find((rs) => rs.slug === 'community-e')!;
    expect(first.lowestLand).toBe(true);
    expect(second.lowestLand).toBe(false);
  });
});
