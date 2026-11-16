/**
 * Community lots refresh (#691) — fixture source + fake land-use provider
 * against the real Drizzle store on PGlite (migration 0055).
 *
 * AC1 lots listed once each with address, area, value, roll year, district,
 * kind. AC2 guards applied end to end. AC3 vanished parcels removed; a
 * re-run over unchanged data changes no rows. AC4 a source failure keeps
 * stored lots, reports the run failed and fires the ops alert.
 * AC8 the measured duration is reported.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCommunityLotsRefreshService,
  createSocrataCommunityLotsSource,
  type CommunityLotsSource,
  type EstablishedCommunity,
} from '../src/services/community-lots-refresh.service';
import { createDrizzleCommunityLotsStore } from '../src/services/community-lots.store';
import type { LandUseProvider } from '../src/services/land-use.service';
import type { LonLat } from '../src/lib/geo';
import { createTestDb, type TestDb } from './pglite-db';

/** Small square parcel around (lon, lat). */
function square(lon: number, lat: number) {
  const d = 0.0001;
  return {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [lon - d, lat - d],
          [lon + d, lat - d],
          [lon + d, lat + d],
          [lon - d, lat + d],
          [lon - d, lat - d],
        ],
      ],
    ],
  };
}

function parcel(roll: string, over: Record<string, unknown> = {}, lon = -114.1, lat = 51.0) {
  return {
    roll_number: roll,
    address: `${roll} TEST ST SW`,
    roll_year: '2026',
    assessed_value: '800000.0',
    land_size_sf: '6000.0',
    land_use_designation: 'R-C2,R-CG',
    property_type: 'LO',
    assessment_class: 'RE',
    multipolygon: square(lon, lat),
    ...over,
  };
}

const ALTADORE: EstablishedCommunity = { name: 'ALTADORE', code: 'ALT', slug: 'altadore' };
const BOWNESS: EstablishedCommunity = { name: 'BOWNESS', code: 'BOW', slug: 'bowness' };

/** District by longitude so each fixture parcel can sit in a chosen zone. */
const DISTRICT_BY_LON: Record<string, string> = {
  '-114.1': 'R-CG',
  '-114.2': 'M-CG', // multi-residential → excluded
  '-114.3': 'H-GO',
};

function fakeLandUse(): LandUseProvider & { calls: number } {
  const p = {
    calls: 0,
    async resolve(point: LonLat) {
      p.calls++;
      const code = DISTRICT_BY_LON[point.lon.toFixed(1)];
      return code ? { district: code, description: '' } : null;
    },
  };
  return p;
}

interface FixtureSource extends CommunityLotsSource {
  parcels: Record<string, unknown[]>;
  communities: EstablishedCommunity[];
  failFor: Set<string>;
}

function fixtureSource(): FixtureSource {
  const src: FixtureSource = {
    parcels: {},
    communities: [ALTADORE, BOWNESS],
    failFor: new Set(),
    async latestRollYear() {
      return '2026';
    },
    async establishedCommunities() {
      return src.communities;
    },
    async vacantParcels(_year, code) {
      if (src.failFor.has(code)) throw new Error('Socrata request failed: 503');
      return src.parcels[code] ?? [];
    },
  };
  return src;
}

const CONFIG = {
  city: 'calgary',
  minLotSqft: 1000,
  allowedDistrictPrefixes: ['R-', 'H-GO'],
  districtConcurrency: 3,
  maxAttempts: 2,
  requestDelayMs: 0,
  alertAfterConsecutiveFailures: 1,
};

describe('community lots refresh (#691)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    await testDb.exec('DELETE FROM community_lots; DELETE FROM community_lot_refreshes;');
  });

  function harness(source = fixtureSource(), landUse: LandUseProvider | null = fakeLandUse()) {
    const store = createDrizzleCommunityLotsStore({ db: testDb.db });
    const onRefreshFailing = vi.fn(async () => {});
    const onRefreshRecovered = vi.fn(async () => {});
    let t = Date.parse('2026-11-16T09:30:00Z');
    const service = createCommunityLotsRefreshService({
      store,
      source,
      ...(landUse ? { landUse } : {}),
      config: CONFIG,
      onRefreshFailing,
      onRefreshRecovered,
      clock: () => new Date((t += 1000)),
      sleep: async () => {},
      logWarning: () => {},
    });
    return { service, store, source, onRefreshFailing, onRefreshRecovered };
  }

  it('AC1/AC2: lists qualifying vacant lots once each with their fields; guards exclude the rest', async () => {
    const h = harness();
    h.source.parcels['ALT'] = [
      parcel('100'),
      parcel('100'), // repeated by the source → listed once
      parcel('101', { land_size_sf: '400' }), // sliver
      parcel('102', {}, -114.2, 51.0), // M-CG multi-residential district
      parcel('103', { assessment_class: 'NR' }), // non-residential
      parcel('104', {}, -114.3, 51.0), // H-GO grade-oriented → kept
      parcel('105', {}, -114.9, 51.0), // no polygon → roll fallback R-C2,R-CG → kept
      parcel('106', { land_use_designation: 'MU-1' }, -114.9, 51.0), // roll fallback MU-1 → excluded
      { address: 'bad row' }, // unparseable
    ];
    const r = await h.service.runRefreshCycle();
    expect(r.status).toBe('ok');
    expect(r.listed).toBe(3);
    expect(r.excluded).toMatchObject({
      sliver: 1,
      'district-not-allowed': 2,
      'not-residential-vacant': 1,
      unparseable: 1,
    });
    expect(typeof r.durationMs).toBe('number'); // AC8: measured duration reported

    const lots = await h.store.listLots('calgary', 'altadore');
    const byRoll = Object.fromEntries(lots.map((l) => [l.rollNumber, l]));
    expect(Object.keys(byRoll).sort()).toEqual(['100', '104', '105']);
    expect(byRoll['100']).toMatchObject({
      address: '100 TEST ST SW',
      lotSqft: 6000,
      assessedValue: 800_000,
      rollYear: '2026',
      district: 'R-CG',
      districtSource: 'land-use-districts',
      kind: 'vacant',
    });
    expect(byRoll['100'].latitude).toBeCloseTo(51.0, 5);
    expect(byRoll['105']).toMatchObject({ district: 'R-CG', districtSource: 'assessment-roll' });

    const refresh = await h.store.getRefresh('calgary', 'altadore');
    expect(refresh).toMatchObject({ communityName: 'ALTADORE', rollYear: '2026', lotCount: 3 });
    // A covered community with no lots is still known (empty list, not 404).
    expect(await h.store.getRefresh('calgary', 'bowness')).toMatchObject({ lotCount: 0 });
    expect(h.onRefreshRecovered).toHaveBeenCalledTimes(1);
  });

  it('AC3: a vanished parcel is removed; a re-run over unchanged data changes no lot rows', async () => {
    const h = harness();
    h.source.parcels['ALT'] = [parcel('200'), parcel('201'), parcel('202')];
    await h.service.runRefreshCycle();
    const snapshot = await testDb.rows(
      `SELECT id, address, assessed_value, district, first_seen_at, updated_at FROM community_lots ORDER BY id`,
    );

    const again = await h.service.runRefreshCycle();
    expect(again).toMatchObject({ inserted: 0, updated: 0, removed: 0, unchanged: 3 });
    expect(
      await testDb.rows(
        `SELECT id, address, assessed_value, district, first_seen_at, updated_at FROM community_lots ORDER BY id`,
      ),
    ).toEqual(snapshot);

    h.source.parcels['ALT'] = [parcel('200'), parcel('202', { assessed_value: '900000' })];
    const third = await h.service.runRefreshCycle();
    expect(third).toMatchObject({ inserted: 0, updated: 1, removed: 1, unchanged: 1 });
    const lots = await h.store.listLots('calgary', 'altadore');
    expect(lots.map((l) => l.rollNumber).sort()).toEqual(['200', '202']);
    expect(lots.find((l) => l.rollNumber === '202')?.assessedValue).toBe(900_000);
  });

  it('AC4: a Socrata failure mid-run keeps stored lots, reports failed and fires the ops alert', async () => {
    const h = harness();
    h.source.parcels['ALT'] = [parcel('300'), parcel('301')];
    h.source.parcels['BOW'] = [parcel('400')];
    await h.service.runRefreshCycle();

    h.source.failFor.add('ALT'); // first community fails, the next still refreshes
    h.source.parcels['BOW'] = [parcel('400'), parcel('401')];
    const r = await h.service.runRefreshCycle();
    expect(r.status).toBe('failed');
    expect(r.failedCommunities).toBe(1);
    expect((await h.store.listLots('calgary', 'altadore')).map((l) => l.rollNumber).sort()).toEqual([
      '300',
      '301',
    ]);
    expect((await h.store.listLots('calgary', 'bowness'))).toHaveLength(2);
    expect(h.onRefreshFailing).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 1 }),
    );

    // Recovery: next clean run clears the alert.
    h.source.failFor.clear();
    const ok = await h.service.runRefreshCycle();
    expect(ok.status).toBe('ok');
    expect(ok.consecutiveFailures).toBe(0);
    expect(h.onRefreshRecovered).toHaveBeenCalled();
  });

  it('AC4: a district lookup that keeps failing fails only that community', async () => {
    const landUse: LandUseProvider = {
      resolve: async () => {
        throw new Error('land-use: HTTP 500');
      },
    };
    const h = harness(fixtureSource(), landUse);
    h.source.parcels['ALT'] = [parcel('500')];
    const r = await h.service.runRefreshCycle();
    expect(r.status).toBe('failed');
    expect(await h.store.getRefresh('calgary', 'altadore')).toBeNull();
    expect(await h.store.getRefresh('calgary', 'bowness')).not.toBeNull();
  });

  it('AC4: listing communities failing writes nothing and throws', async () => {
    const h = harness();
    h.source.parcels['ALT'] = [parcel('600')];
    await h.service.runRefreshCycle();
    h.source.communities = [];
    await expect(h.service.runRefreshCycle()).rejects.toThrow(/refusing to prune/);
    expect(await h.store.listLots('calgary', 'altadore')).toHaveLength(1);
    expect(h.onRefreshFailing).toHaveBeenCalledTimes(1);
  });

  it('drops communities that leave the established set', async () => {
    const h = harness();
    h.source.parcels['ALT'] = [parcel('700')];
    h.source.parcels['BOW'] = [parcel('701')];
    await h.service.runRefreshCycle();
    h.source.communities = [ALTADORE];
    const r = await h.service.runRefreshCycle();
    expect(r.communitiesRemoved).toBe(1);
    expect(await h.store.getRefresh('calgary', 'bowness')).toBeNull();
    expect(await h.store.listLots('calgary', 'bowness')).toHaveLength(0);
  });

  it('without a land-use provider, falls back to the roll designation', async () => {
    const h = harness(fixtureSource(), null);
    h.source.parcels['ALT'] = [parcel('800'), parcel('801', { land_use_designation: 'M-C1' })];
    const r = await h.service.runRefreshCycle();
    expect(r.listed).toBe(1);
    const [only] = await h.store.listLots('calgary', 'altadore');
    expect(only).toMatchObject({ rollNumber: '800', districtSource: 'assessment-roll' });
  });
});

describe('Socrata community-lots source', () => {
  const config = {
    socrataBaseUrl: 'https://data.example',
    assessmentDatasetId: 'assess',
    boundariesDatasetId: 'bounds',
    establishedClasses: ['Residential'],
    establishedStructures: ['INNER CITY', "O'BRIEN"],
    pageSize: 2,
    requestDelayMs: 0,
    httpTimeoutMs: 1000,
    maxAttempts: 2,
  };
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(handler: (url: URL) => { status?: number; body?: unknown }) {
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      const { status = 200, body = [] } = handler(url);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return urls;
  }

  it('pages parcels with a stable order until a short page and quotes SoQL literals', async () => {
    const pages = [[{ a: 1 }, { a: 2 }], [{ a: 3 }]];
    const urls = stubFetch((u) => ({ body: pages[Number(u.searchParams.get('$offset')) / 2] ?? [] }));
    const src = createSocrataCommunityLotsSource(config, async () => {});
    const rows = await src.vacantParcels('2026', 'ALT');
    expect(rows).toHaveLength(3);
    expect(urls).toHaveLength(2);
    const where = urls[0].searchParams.get('$where') ?? '';
    expect(where).toContain("comm_code='ALT'");
    expect(where).toContain("property_type='LO'");
    expect(where).toContain("assessment_class='RE'");
    expect(urls[0].searchParams.get('$order')).toBe('roll_number');
    expect(urls[0].pathname).toBe('/resource/assess.json');

    stubFetch(() => ({ body: [] }));
    await expect(src.vacantParcels('2026', "A'; DROP")).rejects.toThrow(/invalid/);
  });

  it('lists established communities from the boundaries dataset (escaped values)', async () => {
    const urls = stubFetch(() => ({
      body: [
        { name: 'ALTADORE', comm_code: 'ALT' },
        { name: '', comm_code: 'X' },
        { name: 'BAD CODE', comm_code: 'a b' },
      ],
    }));
    const src = createSocrataCommunityLotsSource(config, async () => {});
    expect(await src.establishedCommunities()).toEqual([
      { name: 'ALTADORE', code: 'ALT', slug: 'altadore' },
    ]);
    const where = urls[0].searchParams.get('$where') ?? '';
    expect(where).toContain("comm_structure in('INNER CITY','O''BRIEN')");
    expect(urls[0].pathname).toBe('/resource/bounds.json');
  });

  it('retries a failed request, then throws', async () => {
    let n = 0;
    stubFetch(() => (++n === 1 ? { status: 503 } : { body: [{ roll_year: '2026' }] }));
    const src = createSocrataCommunityLotsSource(config, async () => {});
    expect(await src.latestRollYear()).toBe('2026');
    stubFetch(() => ({ status: 500 }));
    await expect(src.latestRollYear()).rejects.toThrow(/500/);
  });
});
