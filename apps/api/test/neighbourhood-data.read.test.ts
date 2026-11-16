/**
 * Neighbourhood reads (#773 AC3): no provider is called from a request path.
 *
 * Wires the REAL composition with spy providers and a PGlite store, fills the
 * tables through the refresh job, then serves reads and asserts zero
 * provider calls. A static check pins that the read service and the public
 * routes never import the providers or the refresh service.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createComposition } from '../src/composition';
import type {
  CommunityMetricRecord,
  NeighbourhoodProvider,
  NeighbourhoodProviders,
} from '../src/services/neighbourhood-data/providers';
import { createDrizzleNeighbourhoodDataStore } from '../src/services/neighbourhood-data/neighbourhood-data.store';
import {
  boundingBox,
  createNeighbourhoodReadService,
  treeCoverLevel,
} from '../src/services/neighbourhood-data/neighbourhood-read.service';
import { createDrizzleCityDataCacheStore } from '../src/services/city-data-cache.store';
import { createTestDb, type TestDb } from './pglite-db';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

/** Lot near Altadore; one school ~300 m away, one ~5 km away. */
const LOT = { addressKey: '4500 16 ST SW', lat: 51.0137, lng: -114.0983 };

function spy<T>(implementation: string, rows: T[]) {
  const counter = { calls: 0 };
  const provider: NeighbourhoodProvider<T> = {
    implementation,
    fetchAll: async () => {
      counter.calls++;
      return rows;
    },
  };
  return { provider, counter };
}

describe('neighbourhood reads never call a provider (#773 AC3)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('serves lot and community metrics from our tables with zero provider calls', async () => {
    const spies = {
      schoolDirectory: spy('fake', [
        { externalId: 'near', name: 'Near School', board: 'CBE', grades: 'K-6', lat: 51.0164, lng: -114.0983, data: {} },
        { externalId: 'far', name: 'Far School', board: 'CBE', grades: '7-9', lat: 51.06, lng: -114.06, data: {} },
      ]),
      schoolDesignation: spy('fake', [] as never[]),
      schoolRatings: spy('fake', [] as never[]),
      reviews: spy('fake', [] as never[]),
      amenities: spy('fake', [
        { externalId: 'cc', category: 'Community Centre', name: 'Altadore CA', lat: 51.014, lng: -114.099, data: {} },
      ]),
      commute: spy<CommunityMetricRecord>('fake', [
        { externalId: 'ALT', communityCode: 'ALT', data: { destination: 'Downtown', straightLineKm: 4.9 } },
      ]),
    };
    const providers = Object.fromEntries(
      Object.entries(spies).map(([k, v]) => [k, v.provider]),
    ) as unknown as NeighbourhoodProviders;
    const app = createComposition(TEST_ENV, {
      neighbourhoodDataStore: createDrizzleNeighbourhoodDataStore({ db: testDb.db }),
      neighbourhoodProviders: providers,
      cityDataCacheStore: createDrizzleCityDataCacheStore({ db: testDb.db }),
    });

    // Monthly job fills the tables (the only provider caller).
    await app.neighbourhoodRefreshService.refreshNow('school-directory');
    await app.neighbourhoodRefreshService.refreshNow('amenities');
    await app.neighbourhoodRefreshService.refreshNow('commute');
    for (const s of Object.values(spies)) s.counter.calls = 0;

    // Serve reads — twice (computed, then cached).
    for (let i = 0; i < 2; i++) {
      const lot = await app.neighbourhoodReadService.getLotLivingMetrics(LOT);
      expect(lot.schools.map((s) => s.name)).toEqual(['Near School']);
      expect(lot.schools[0]!.distanceM).toBeGreaterThan(250);
      expect(lot.schools[0]!.distanceM).toBeLessThan(350);
      expect(lot.amenityCounts).toEqual({ 'Community Centre': 1 });
      const community = await app.neighbourhoodReadService.getCommunityLivingMetrics('alt');
      expect(community.metrics['commute']).toEqual({
        source: 'fake',
        data: { destination: 'Downtown', straightLineKm: 4.9 },
      });
    }

    for (const [name, s] of Object.entries(spies)) {
      expect(s.counter.calls, `${name} provider was called while serving reads`).toBe(0);
    }
    // The per-address result was cached on first read.
    expect(await testDb.rows('select address_key from lot_living_metrics')).toHaveLength(1);
  });

  it('read service and public routes have no path to a provider (static)', () => {
    const src = join(__dirname, '..', 'src');
    const read = readFileSync(join(src, 'services/neighbourhood-data/neighbourhood-read.service.ts'), 'utf8');
    expect(read).not.toMatch(/from '\.\/providers'|neighbourhood-refresh\.service/);
    for (const file of readdirSync(join(src, 'routes')).filter((f) => f.endsWith('.ts'))) {
      if (file === 'admin-neighbourhood-data.route.ts') continue; // admin "refresh now"
      const text = readFileSync(join(src, 'routes', file), 'utf8');
      expect(text, `${file} must not reach neighbourhood providers`).not.toMatch(
        /neighbourhood-data\/(providers|neighbourhood-refresh\.service)/,
      );
    }
  });

  it('community metrics (#777): nearest + counts per configured category and tree cover, by slug or code; second read from the shared cache', async () => {
    await testDb.exec('delete from city_data_cache');
    const realStore = createDrizzleNeighbourhoodDataStore({ db: testDb.db });
    // Tree-cover anchor (Altadore centre) + amenities at known distances.
    await realStore.replaceSnapshot(
      'amenities',
      'fake',
      [
        {
          externalId: 'tree-cover|alt',
          category: 'tree-cover',
          name: 'ALTADORE',
          communityCode: 'ALT',
          lat: 51.0137,
          lng: -114.0983,
          data: { slug: 'altadore', publicTrees: 2000, areaHa: 100, treesPerHa: 20 },
        },
        // ~300 m north
        { externalId: 'p1', category: 'parks', name: 'Near Park', lat: 51.0164, lng: -114.0983, data: {} },
        // ~800 m north
        { externalId: 'p2', category: 'parks', name: 'Mid Park', lat: 51.0209, lng: -114.0983, data: {} },
        // ~2 km north: nearest-eligible but outside both count radii
        { externalId: 'l1', category: 'libraries', name: 'Far Library', lat: 51.0317, lng: -114.0983, data: {} },
        // ~10 km: outside the search radius
        { externalId: 'o1', category: 'off-leash', name: 'Too Far', lat: 51.1037, lng: -114.0983, data: {} },
      ],
      new Date('2026-11-01T07:00:00Z'),
    );
    const calls = { anchor: 0 };
    const store = {
      ...realStore,
      communityAnchor: async (key: string) => {
        calls.anchor++;
        return realStore.communityAnchor(key);
      },
    };
    const service = createNeighbourhoodReadService({
      store,
      lotRadiusM: 1_000,
      lotMetricsTtlMs: 60_000,
      amenityCategories: [
        { key: 'parks', label: 'Parks' },
        { key: 'libraries', label: 'Libraries' },
        { key: 'off-leash', label: 'Off-leash areas' },
      ],
      amenitySearchRadiusM: 3_000,
      amenityCountRadiiM: [500, 1_000],
      treeCoverThresholds: [11, 16],
      communityCache: createDrizzleCityDataCacheStore({ db: testDb.db }),
      communityMetricsTtlMs: 60_000,
    });

    const m = await service.getCommunityLivingMetrics('altadore');
    expect(m).toMatchObject({ communityCode: 'ALT', name: 'ALTADORE', slug: 'altadore', searchRadiusM: 3_000 });
    expect(m.dataRefreshedAt).toBe('2026-11-01T07:00:00.000Z');
    const [parks, libraries, offLeash] = m.amenities;
    expect(parks).toMatchObject({
      category: 'parks',
      label: 'Parks',
      nearest: { name: 'Near Park' },
      counts: [
        { radiusM: 500, count: 1 },
        { radiusM: 1_000, count: 2 },
      ],
    });
    expect(parks!.nearest!.distanceM).toBeGreaterThan(250);
    expect(parks!.nearest!.distanceM).toBeLessThan(350);
    expect(libraries).toMatchObject({ nearest: { name: 'Far Library' }, counts: [{ count: 0 }, { count: 0 }] });
    expect(offLeash).toMatchObject({ nearest: null, counts: [{ count: 0 }, { count: 0 }] });
    expect(m.treeCover).toEqual({ publicTrees: 2000, areaHa: 100, treesPerHa: 20, level: 'high' });
    expect(calls.anchor).toBe(1);

    // Second request: served from the shared cache, no recomputation.
    expect(await service.getCommunityLivingMetrics('altadore')).toEqual(m);
    expect(calls.anchor).toBe(1);
    // Code lookup resolves the same community.
    expect((await service.getCommunityLivingMetrics('ALT')).slug).toBe('altadore');

    // Tree-cover anchors are never counted as nearby amenities of a lot.
    const lot = await service.getLotLivingMetrics({ addressKey: 'cover-check', lat: 51.0137, lng: -114.0983 });
    expect(lot.amenityCounts).toEqual({ parks: 2 });

    // Unknown community: no anchor, nothing cached.
    const unknown = await service.getCommunityLivingMetrics('nowhere');
    expect(unknown).toMatchObject({ name: null, amenities: [], treeCover: null });
    expect(
      await testDb.rows("select key from city_data_cache where key like 'neighbourhood-community-living:%'"),
    ).toHaveLength(2);
  });

  it('a failing shared cache falls back to computing (never fails the read)', async () => {
    const service = createNeighbourhoodReadService({
      store: {
        schoolsIn: async () => [],
        amenitiesIn: async () => [],
        communityAnchor: async () => null,
        communityMetrics: async () => [{ metric: 'commute', source: 'fake', data: {}, refreshedAt: new Date() }],
        getLotMetrics: async () => undefined,
        putLotMetrics: async () => undefined,
      },
      lotRadiusM: 1_000,
      lotMetricsTtlMs: 1,
      amenityCategories: [],
      amenitySearchRadiusM: 3_000,
      amenityCountRadiiM: [500],
      treeCoverThresholds: [11, 16],
      communityCache: {
        get: async () => {
          throw new Error('db down');
        },
        put: async () => {
          throw new Error('db down');
        },
      },
      communityMetricsTtlMs: 1,
      logWarning: () => undefined,
    });
    const m = await service.getCommunityLivingMetrics('ALT');
    expect(m.metrics['commute']).toBeDefined();
  });

  it('treeCoverLevel buckets by the configured thresholds', () => {
    expect(treeCoverLevel(10.9, [11, 16])).toBe('low');
    expect(treeCoverLevel(11, [11, 16])).toBe('moderate');
    expect(treeCoverLevel(16, [11, 16])).toBe('high');
  });

  it('boundingBox widens longitude with latitude', () => {
    const box = boundingBox(51, -114, 1_000);
    expect(box.maxLat - box.minLat).toBeCloseTo(0.018, 3);
    expect(box.maxLng - box.minLng).toBeGreaterThan(box.maxLat - box.minLat);
  });
});
