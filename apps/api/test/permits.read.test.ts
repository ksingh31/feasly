/**
 * Nearby permits reads (#822) against PGlite.
 *
 * AC1: a test address shows the correct count from fixture data, plus the
 *      expandable list.
 * AC2: the response carries the as-of of the monthly load.
 * AC3: zero City calls per page view — the real composition serves the
 *      address + community summaries with no fetch and no provider call
 *      once the page's property lookup is cached.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComposition } from '../src/composition';
import type {
  NeighbourhoodProvider,
  NeighbourhoodProviders,
  PermitRecord,
} from '../src/services/neighbourhood-data/providers';
import { createDrizzleNeighbourhoodDataStore } from '../src/services/neighbourhood-data/neighbourhood-data.store';
import { createNeighbourhoodRefreshService } from '../src/services/neighbourhood-data/neighbourhood-refresh.service';
import {
  createPermitsReadService,
  dpToBpDays,
  medianWeeks,
} from '../src/services/neighbourhood-data/permits-read.service';
import { createDrizzleCityDataCacheStore } from '../src/services/city-data-cache.store';
import { createTestDb, type TestDb } from './pglite-db';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

/** The test address (Altadore) and ~100 m of latitude / ~70 m of longitude. */
const HOME = { lat: 51.0137, lng: -114.0983 };
const N100 = 0.0009;
const E70 = 0.001;
const NOW = new Date('2026-11-16T07:00:00Z');

let seq = 0;
function permit(p: Partial<PermitRecord> & Pick<PermitRecord, 'kind' | 'permitNumber'>): PermitRecord {
  seq++;
  return {
    externalId: `${p.kind}|${p.permitNumber}`.toLowerCase(),
    communityCode: 'ALT',
    lat: HOME.lat,
    lng: HOME.lng,
    address: `${4500 + seq} 16 ST SW`,
    permitType: p.kind === 'building' ? 'Single Family' : 'Residential - New Single / Semi / Duplex',
    status: 'Issued Permit',
    appliedOn: null,
    decidedOn: null,
    housingUnits: null,
    builder: null,
    data: { communityName: 'ALTADORE', slug: 'altadore' },
    ...p,
  };
}

/**
 * Within 300 m since 2024: BP1, BP2, BP3 issued (2 + 1 + 1 unit), one
 * pending BP; DP1 + DP2 applied in the window (DP3 in 2023). DP→BP spans:
 * 273, 276, 275 days → median 275 d → 39 weeks.
 */
const FIXTURE: PermitRecord[] = [
  permit({ kind: 'building', permitNumber: 'BP2025-00001', address: '4504 16 ST SW', lat: HOME.lat + N100, appliedOn: '2025-03-01', decidedOn: '2025-06-01', housingUnits: 2, builder: 'ACME HOMES LTD', permitType: 'Two Family' }),
  permit({ kind: 'development', permitNumber: 'DP2024-00010', address: '4504 16 ST SW', lat: HOME.lat + N100, appliedOn: '2024-09-01', decidedOn: '2024-12-01', status: 'Released' }),
  permit({ kind: 'building', permitNumber: 'BP2026-00002', address: '4520 16 ST SW', lat: HOME.lat + 2 * N100, appliedOn: '2025-11-01', decidedOn: '2026-02-01', housingUnits: 1 }),
  permit({ kind: 'development', permitNumber: 'DP2025-00020', address: '4520 16 ST SW', lat: HOME.lat + 2 * N100, appliedOn: '2025-05-01', decidedOn: '2025-08-01', status: 'Released' }),
  permit({ kind: 'building', permitNumber: 'BP2024-00003', address: '1700 45 AV SW', lng: HOME.lng + 3.5 * E70, appliedOn: '2024-01-02', decidedOn: '2024-04-01' }),
  permit({ kind: 'development', permitNumber: 'DP2023-00030', address: '1700 45 AV SW', lng: HOME.lng + 3.5 * E70, appliedOn: '2023-07-01', decidedOn: '2023-10-01', status: 'Released' }),
  // Pending BP: listed, not counted.
  permit({ kind: 'building', permitNumber: 'BP2026-00004', lat: HOME.lat - N100, appliedOn: '2026-08-01', status: 'In Review' }),
  // Before the lookback window.
  permit({ kind: 'building', permitNumber: 'BP2022-00005', lat: HOME.lat - 1.5 * N100, appliedOn: '2022-01-10', decidedOn: '2022-04-01' }),
  // Outside the 300 m radius (~600 m).
  permit({ kind: 'building', permitNumber: 'BP2025-00006', lat: HOME.lat + 6 * N100, appliedOn: '2025-01-01', decidedOn: '2025-04-01' }),
  // Another community, far away.
  permit({ kind: 'building', permitNumber: 'BP2025-00007', communityCode: 'KIL', lat: 51.03, lng: -114.14, appliedOn: '2025-01-01', decidedOn: '2025-03-01', data: { communityName: 'KILLARNEY/GLENGARRY', slug: 'killarney-glengarry' } }),
];

/** A square parcel around HOME (the roll's multipolygon). */
const ROLL_ROW = {
  roll_year: '2026',
  address: '4500 16 ST SW',
  assessed_value: '900000',
  assessment_class: 'RE',
  assessment_class_description: 'Residential',
  comm_name: 'ALTADORE',
  year_of_construction: '1952',
  land_use_designation: 'R-CG',
  land_size_sf: '6000',
  mod_date: '2026-01-15T00:00:00.000',
  multipolygon: {
    type: 'MultiPolygon',
    coordinates: [[[
      [HOME.lng - 0.0001, HOME.lat - 0.0001],
      [HOME.lng + 0.0001, HOME.lat - 0.0001],
      [HOME.lng + 0.0001, HOME.lat + 0.0001],
      [HOME.lng - 0.0001, HOME.lat + 0.0001],
      [HOME.lng - 0.0001, HOME.lat - 0.0001],
    ]]],
  },
};

function spyProvider<T>(rows: T[]) {
  const counter = { calls: 0 };
  const provider: NeighbourhoodProvider<T> = {
    implementation: 'fake',
    fetchAll: async () => {
      counter.calls++;
      return rows;
    },
  };
  return { provider, counter };
}

const none = <T,>(): NeighbourhoodProvider<T> => ({ implementation: 'none', fetchAll: async () => [] });

describe('nearby permits (#822)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    await testDb.exec('DELETE FROM permits; DELETE FROM neighbourhood_refresh_state; DELETE FROM city_data_cache;');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function load(rows: PermitRecord[] = FIXTURE): Promise<{ calls: number }> {
    const spy = spyProvider(rows);
    const store = createDrizzleNeighbourhoodDataStore({ db: testDb.db });
    const refresh = createNeighbourhoodRefreshService({
      providers: { permits: spy.provider } as unknown as NeighbourhoodProviders,
      store,
      refreshDayOfMonth: 1,
      alertAfterFailureDays: 3,
      onFailing: async () => {},
      onRecovered: async () => {},
      clock: () => NOW,
      logWarning: () => {},
    });
    expect(await refresh.refreshNow('permits')).toMatchObject({ outcome: 'ok', rowsTotal: rows.length });
    return spy.counter;
  }

  function service(
    locate = vi.fn(async (): Promise<{ lat: number; lon: number } | null> => ({ lat: HOME.lat, lon: HOME.lng })),
  ) {
    return {
      locate,
      read: createPermitsReadService({
        store: createDrizzleNeighbourhoodDataStore({ db: testDb.db }),
        locator: { getPropertyPoint: locate },
        radiusM: 300,
        lookbackYears: 2,
        historyYears: 5,
        listLimit: 10,
        minSample: 3,
        dpBpMaxGapDays: 1_095,
        recordUrlTemplate: 'https://dmap.calgary.ca/?find={permitNumber}',
        cache: createDrizzleCityDataCacheStore({ db: testDb.db }),
        summaryTtlMs: 86_400_000,
        clock: () => NOW,
        logWarning: () => {},
      }),
    };
  }

  it('AC1 + AC2: correct counts from fixture data, the expandable list, and the as-of date', async () => {
    await load();
    const { read } = service();
    const result = await read.getNearbyPermits('4500 16 ST SW');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.value;
    expect(m).toMatchObject({
      addressKey: '4500 16 ST SW',
      radiusM: 300,
      sinceYear: 2024,
      buildingPermits: 3,
      newHomes: 4,
      developmentPermits: 2,
      typicalDpToBpWeeks: 39,
      total: 6,
      dataRefreshedAt: NOW.toISOString(),
    });
    // Most recent first; old, far and other-community permits excluded.
    expect(m.permits.map((p) => p.permitNumber)).toEqual([
      'BP2026-00004',
      'BP2026-00002',
      'DP2025-00020',
      'BP2025-00001',
      'DP2024-00010',
      'BP2024-00003',
    ]);
    expect(m.permits[3]).toEqual({
      kind: 'building',
      permitNumber: 'BP2025-00001',
      address: '4504 16 ST SW',
      permitType: 'Two Family',
      status: 'Issued Permit',
      year: 2025,
      builder: 'ACME HOMES LTD',
      distanceM: 100,
      recordUrl: 'https://dmap.calgary.ca/?find=BP2025-00001',
    });
    expect(m.permits[0]).toMatchObject({ year: 2026, status: 'In Review' });
  });

  it('list is capped at the configured limit while total keeps the full count', async () => {
    await load();
    const read = createPermitsReadService({
      store: createDrizzleNeighbourhoodDataStore({ db: testDb.db }),
      locator: { getPropertyPoint: async () => ({ lat: HOME.lat, lon: HOME.lng }) },
      radiusM: 300,
      lookbackYears: 2,
      historyYears: 5,
      listLimit: 2,
      minSample: 3,
      dpBpMaxGapDays: 1_095,
      recordUrlTemplate: 'https://example.org/p/{permitNumber}',
      summaryTtlMs: 1,
      clock: () => NOW,
    });
    const result = await read.getNearbyPermits('4500 16 ST SW');
    expect(result.ok && result.value.permits.length).toBe(2);
    expect(result.ok && result.value.total).toBe(6);
  });

  it('community: permits per year and median approval times, by slug or code', async () => {
    await load();
    const { read } = service();
    const bySlug = await read.getCommunityPermits('altadore');
    const byCode = await read.getCommunityPermits('ALT');
    expect(bySlug.ok && byCode.ok).toBe(true);
    if (!bySlug.ok || !byCode.ok) return;
    expect(byCode.value).toEqual(bySlug.value);
    expect(bySlug.value).toMatchObject({
      communityCode: 'ALT',
      name: 'ALTADORE',
      slug: 'altadore',
      sinceYear: 2024,
      dataRefreshedAt: NOW.toISOString(),
    });
    expect(bySlug.value.perYear).toEqual([
      { year: 2021, buildingPermits: 0, newHomes: 0, developmentPermits: 0 },
      { year: 2022, buildingPermits: 1, newHomes: 1, developmentPermits: 0 },
      { year: 2023, buildingPermits: 0, newHomes: 0, developmentPermits: 1 },
      { year: 2024, buildingPermits: 1, newHomes: 1, developmentPermits: 1 },
      { year: 2025, buildingPermits: 2, newHomes: 3, developmentPermits: 1 },
      { year: 2026, buildingPermits: 1, newHomes: 1, developmentPermits: 0 },
    ]);
    // BPs decided since 2024: 92, 92, 90, 90 days → 13 weeks. DPs since
    // 2024: two of 91/92 days → below the minimum sample → null.
    expect(bySlug.value.medianApprovalWeeks).toEqual({ buildingPermit: 13, developmentPermit: null, dpToBp: 39 });
  });

  it('unknown community and a parcel without geometry are "unavailable", never zero', async () => {
    await load();
    const { read } = service(vi.fn(async () => null));
    expect(await read.getCommunityPermits('nowhere')).toEqual({ ok: false, reason: 'unknown-community' });
    expect(await read.getNearbyPermits('1 NOWHERE ST SW')).toEqual({ ok: false, reason: 'no-location' });
  });

  it('before the first monthly load the summaries are "not-loaded" (no misleading zeros)', async () => {
    const { read, locate } = service();
    expect(await read.getNearbyPermits('4500 16 ST SW')).toEqual({ ok: false, reason: 'not-loaded' });
    expect(await read.getCommunityPermits('altadore')).toEqual({ ok: false, reason: 'not-loaded' });
    expect(locate).not.toHaveBeenCalled();
  });

  it('second read is served from the shared cache; a new monthly load is a miss', async () => {
    await load();
    const { read, locate } = service();
    await read.getNearbyPermits('4500 16 ST SW');
    await read.getNearbyPermits('4500 16 ST SW');
    expect(locate).toHaveBeenCalledTimes(1);
    // A later refresh (new as-of) recomputes.
    await testDb.exec(`UPDATE neighbourhood_refresh_state SET last_success_at = now() WHERE provider = 'permits'`);
    await read.getNearbyPermits('4500 16 ST SW');
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it('AC3: zero City calls per page view (real composition, cached property lookup)', async () => {
    const counter = await load();
    counter.calls = 0;
    const spies = { permits: spyProvider<PermitRecord>(FIXTURE) };
    const providers = {
      schoolDirectory: none(),
      schoolDesignation: none(),
      schoolRatings: none(),
      reviews: none(),
      amenities: none(),
      commute: none(),
      permits: spies.permits.provider,
    } as unknown as NeighbourhoodProviders;
    const app = createComposition(TEST_ENV, {
      neighbourhoodDataStore: createDrizzleNeighbourhoodDataStore({ db: testDb.db }),
      neighbourhoodProviders: providers,
      cityDataCacheStore: createDrizzleCityDataCacheStore({ db: testDb.db }),
    });

    // The page's property lookup (cached from here on — #756).
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => [ROLL_ROW] }));
    vi.stubGlobal('fetch', fetchSpy);
    await app.propertyRoute.lookup('4500 16 ST SW');
    fetchSpy.mockClear();

    for (let view = 0; view < 2; view++) {
      const nearby = await app.permitsRoute.nearby('4500 16 ST SW');
      expect(nearby.addressKey).toBe('4500 16 ST SW');
      expect(nearby.radiusM).toBe(300);
      const community = await app.permitsRoute.community('altadore');
      expect(community.slug).toBe('altadore');
    }
    expect(fetchSpy, 'a page view made a City call').not.toHaveBeenCalled();
    expect(spies.permits.counter.calls, 'a page view called the permits provider').toBe(0);
    expect(counter.calls).toBe(0);
  });
});

describe('permit medians (#822)', () => {
  it('medianWeeks: null below the minimum sample, rounded weeks otherwise', () => {
    expect(medianWeeks([70, 77], 3)).toBeNull();
    expect(medianWeeks([70, 77, 84], 3)).toBe(11);
    expect(medianWeeks([70, 77, 84, 91], 3)).toBe(12);
    expect(medianWeeks([-5, 70, 77, 84], 3)).toBe(11);
  });

  it('dpToBpDays links a BP to the latest DP at the same address within the gap', () => {
    const base = { kind: 'building' as const, permitNumber: 'X', permitType: null, status: null, housingUnits: null, builder: null, communityCode: 'ALT', lat: 0, lng: 0, data: {} };
    const bp = { ...base, address: '1 A ST SW', appliedOn: '2025-03-01', decidedOn: '2025-06-01' };
    const dps = [
      { ...base, kind: 'development' as const, address: '1  a st sw', appliedOn: '2024-09-01', decidedOn: null },
      { ...base, kind: 'development' as const, address: '1 A ST SW', appliedOn: '2020-01-01', decidedOn: null },
      { ...base, kind: 'development' as const, address: '1 A ST SW', appliedOn: '2025-04-01', decidedOn: null },
      { ...base, kind: 'development' as const, address: '2 A ST SW', appliedOn: '2025-01-01', decidedOn: null },
    ];
    expect(dpToBpDays([bp], dps, 1_095)).toEqual([273]);
    expect(dpToBpDays([bp], dps, 100)).toEqual([]);
    expect(dpToBpDays([{ ...bp, decidedOn: null }], dps, 1_095)).toEqual([]);
  });
});
