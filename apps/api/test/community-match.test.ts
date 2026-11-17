/**
 * Community match (#778).
 *
 * - Pure scoring: same priorities → same ranking (AC1); every result has a
 *   reason and lists its must-have misses (AC2); a missed must-have ranks
 *   below every community that passes; filters; frontage estimate.
 * - Service: builds the snapshot from tables only, reuses it from memory and
 *   the shared cache, prices typical new-build ranges with the cost engine,
 *   and scores 110 communities well inside the 300 ms p95 budget (AC3).
 * - Route: body validation and unknown-priority 400s.
 * - End to end on PGlite through the real composition and store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateBuildBand, PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { loadConfig } from '../src/config';
import { createComposition } from '../src/composition';
import { HttpError } from '../src/middleware/errors';
import { createCommunityMatchRoute } from '../src/routes/community-match.route';
import {
  COMMUNITY_MATCH_CACHE_DATASET,
  createCommunityMatchService,
  type CommunityMatchServiceDeps,
} from '../src/services/community-match/community-match.service';
import type { CommunityMatchStore } from '../src/services/community-match/community-match.store';
import { createDrizzleCommunityMatchStore } from '../src/services/community-match/community-match.store';
import {
  countLots,
  formatMeters,
  priorityDefinitions,
  rankCommunities,
  UnknownPriorityError,
  type CommunityMatchInput,
  type MatchPriority,
  type ScoringConfig,
} from '../src/services/community-match/scoring';
import { createDrizzleCityDataCacheStore } from '../src/services/city-data-cache.store';
import { createDrizzleNeighbourhoodDataStore } from '../src/services/neighbourhood-data/neighbourhood-data.store';
import type { CommunityLivingMetrics } from '../src/services/neighbourhood-data/neighbourhood-read.service';
import { createTestDb, type TestDb } from './pglite-db';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

const CATEGORIES = [
  { key: 'parks', label: 'Parks' },
  { key: 'libraries', label: 'Libraries' },
];
const DEFS = priorityDefinitions(CATEGORIES);
const CFG: ScoringConfig = {
  mustWeight: 3,
  niceWeight: 1,
  nearRadiusM: 1_000,
  searchRadiusM: 3_000,
  treeCoverScores: { low: 0, moderate: 0.5, high: 1 },
  typicalLotDepthFt: 120,
  maxReasons: 3,
};

function community(over: Partial<CommunityMatchInput> & { communityCode: string }): CommunityMatchInput {
  return {
    slug: over.communityCode.toLowerCase(),
    name: over.communityCode,
    amenityNearestM: {},
    treeCover: null,
    designatedBands: [],
    lotSqft: [],
    lotsRefreshedAt: null,
    ...over,
  };
}

const ALPHA = community({
  communityCode: 'AAA',
  name: 'Alpha',
  amenityNearestM: { parks: 300, libraries: 2_500 },
  treeCover: { level: 'high', treesPerHa: 21.4 },
  designatedBands: ['K-6', '7-9', '10-12'],
  lotSqft: [6_000, 3_000, null],
});
const BRAVO = community({
  communityCode: 'BBB',
  name: 'Bravo',
  amenityNearestM: { parks: 2_000, libraries: 400 },
  treeCover: { level: 'moderate', treesPerHa: 13 },
  designatedBands: ['K-9'],
  lotSqft: [4_000],
});
const CHARLIE = community({
  communityCode: 'CCC',
  name: 'Charlie',
  amenityNearestM: { parks: null, libraries: null },
  treeCover: { level: 'low', treesPerHa: 5 },
});
const ALL = [CHARLIE, BRAVO, ALPHA];

describe('community match scoring (pure)', () => {
  it('AC1: the same priorities always give the same ranking, whatever the input order', () => {
    const priorities: MatchPriority[] = [
      { key: 'parks', importance: 'nice' },
      { key: 'libraries', importance: 'nice' },
      { key: 'tree-cover', importance: 'nice' },
    ];
    const first = rankCommunities(ALL, priorities, {}, DEFS, CFG);
    for (const order of [[ALPHA, BRAVO, CHARLIE], [BRAVO, CHARLIE, ALPHA], ALL]) {
      for (let i = 0; i < 3; i++) {
        expect(rankCommunities(order, priorities, {}, DEFS, CFG)).toEqual(first);
      }
    }
    expect(first.map((r) => [r.rank, r.input.name])).toEqual([
      [1, 'Alpha'],
      [2, 'Bravo'],
      [3, 'Charlie'],
    ]);
  });

  it('weights must > nice and scores 0–100', () => {
    // parks must (Alpha 1, Bravo 0.5), libraries nice (Alpha 0.25, Bravo 1).
    const ranked = rankCommunities(
      [ALPHA, BRAVO],
      [
        { key: 'parks', importance: 'must' },
        { key: 'libraries', importance: 'nice' },
      ],
      {},
      DEFS,
      CFG,
    );
    const alpha = ranked.find((r) => r.input.name === 'Alpha')!;
    const bravo = ranked.find((r) => r.input.name === 'Bravo')!;
    expect(alpha.match).toBe(Math.round(((3 * 1 + 1 * 0.25) / 4) * 100)); // 81
    expect(bravo.match).toBe(Math.round(((3 * 0.5 + 1 * 1) / 4) * 100)); // 63
    for (const r of ranked) {
      expect(r.match).toBeGreaterThanOrEqual(0);
      expect(r.match).toBeLessThanOrEqual(100);
    }
  });

  it('a community missing a must-have ranks below all that pass, even with a higher score, and says why', () => {
    // Bravo misses the parks must (2 km) but scores higher on many nice-to-haves.
    const ranked = rankCommunities(
      [ALPHA, BRAVO],
      [
        { key: 'parks', importance: 'must' },
        { key: 'libraries', importance: 'nice' },
        { key: 'designated-schools', importance: 'nice' },
      ],
      {},
      DEFS,
      { ...CFG, mustWeight: 1.01, niceWeight: 1 },
    );
    const [first, second] = ranked;
    expect(first!.input.name).toBe('Alpha');
    expect(first!.passesMustHaves).toBe(true);
    expect(second!.passesMustHaves).toBe(false);
    expect(second!.misses[0]).toEqual({
      priority: 'parks',
      importance: 'must',
      text: 'Parks: nearest about 2 km away (straight-line)',
    });

    // Same data, Bravo's must now met → it can outrank on score.
    const flipped = rankCommunities(
      [ALPHA, BRAVO],
      [{ key: 'libraries', importance: 'must' }],
      {},
      DEFS,
      CFG,
    );
    expect(flipped.map((r) => r.input.name)).toEqual(['Bravo', 'Alpha']);
    expect(flipped[1]!.passesMustHaves).toBe(false);
  });

  it('AC2: every result lists at least one reason and every must-have miss', () => {
    const priorities: MatchPriority[] = [
      { key: 'parks', importance: 'must' },
      { key: 'libraries', importance: 'must' },
      { key: 'tree-cover', importance: 'must' },
      { key: 'designated-schools', importance: 'must' },
    ];
    for (const r of rankCommunities(ALL, priorities, {}, DEFS, CFG)) {
      expect(r.reasons.length).toBeGreaterThanOrEqual(1);
      expect(r.reasons.length).toBeLessThanOrEqual(CFG.maxReasons);
      const mustMisses = r.misses.filter((m) => m.importance === 'must').map((m) => m.priority);
      expect(r.passesMustHaves).toBe(mustMisses.length === 0);
    }
    const charlie = rankCommunities([CHARLIE], priorities, {}, DEFS, CFG)[0]!;
    expect(charlie.misses.map((m) => m.text)).toEqual([
      'Parks: none within 3 km',
      'Libraries: none within 3 km',
      'Public tree cover: low (5 City trees per hectare)',
      'No typically designated school on file for K–6, 7–9 and 10–12 (confirm with the board)',
    ]);
    // Nothing met, no lots → the plain fact.
    expect(charlie.reasons).toEqual([{ priority: 'established', importance: null, text: 'Established infill community' }]);
  });

  it('reasons are the met priorities, strongest first; nice misses follow must misses', () => {
    const r = rankCommunities(
      [ALPHA],
      [
        { key: 'libraries', importance: 'nice' },
        { key: 'tree-cover', importance: 'nice' },
        { key: 'designated-schools', importance: 'must' },
        { key: 'parks', importance: 'nice' },
      ],
      {},
      DEFS,
      CFG,
    )[0]!;
    expect(r.reasons).toEqual([
      {
        priority: 'designated-schools',
        importance: 'must',
        text: 'Typically designated schools for K–6, 7–9 and 10–12 (confirm with the board)',
      },
      { priority: 'tree-cover', importance: 'nice', text: 'Public tree cover: high (21 City trees per hectare)' },
      { priority: 'parks', importance: 'nice', text: 'Parks: nearest about 300 m away (straight-line)' },
    ]);
    expect(r.misses).toEqual([
      { priority: 'libraries', importance: 'nice', text: 'Libraries: nearest about 2.5 km away (straight-line)' },
    ]);
  });

  it('K-9 covers elementary and junior high; partial school coverage is a partial score', () => {
    const r = rankCommunities([BRAVO], [{ key: 'designated-schools', importance: 'nice' }], {}, DEFS, CFG)[0]!;
    expect(r.match).toBe(67);
    expect(r.misses[0]!.text).toBe(
      'Typically designated schools for K–6 and 7–9; none on file for 10–12 (confirm with the board)',
    );
    // The best partial nice-to-have stands in as the reason.
    expect(r.reasons[0]!.priority).toBe('designated-schools');
  });

  it('filters: lotsListedNow drops communities without a matching lot; minFrontageFt uses area / typical depth', () => {
    expect(countLots(ALPHA, {}, 120)).toEqual({ listed: 3, matching: 3 });
    // 6000/120 = 50 ft, 3000/120 = 25 ft; null area never matches a frontage filter.
    expect(countLots(ALPHA, { minFrontageFt: 50 }, 120)).toEqual({ listed: 3, matching: 1 });
    expect(countLots(ALPHA, { minFrontageFt: 51 }, 120)).toEqual({ listed: 3, matching: 0 });

    const p: MatchPriority[] = [{ key: 'parks', importance: 'nice' }];
    expect(rankCommunities(ALL, p, { lotsListedNow: true }, DEFS, CFG).map((r) => r.input.name)).toEqual([
      'Alpha',
      'Bravo',
    ]);
    expect(
      rankCommunities(ALL, p, { lotsListedNow: true, minFrontageFt: 40 }, DEFS, CFG).map((r) => r.input.name),
    ).toEqual(['Alpha']);
    // Without lotsListedNow the frontage filter only narrows the counts.
    const ranked = rankCommunities(ALL, p, { minFrontageFt: 40 }, DEFS, CFG);
    expect(ranked).toHaveLength(3);
    expect(ranked.find((r) => r.input.name === 'Bravo')!.lots).toEqual({ listed: 1, matching: 0 });
  });

  it('ties break on name, then City code', () => {
    const twinA = community({ communityCode: 'ZZZ', name: 'Same' });
    const twinB = community({ communityCode: 'YYY', name: 'Same' });
    const other = community({ communityCode: 'XXX', name: 'Other' });
    const ranked = rankCommunities([twinA, other, twinB], [{ key: 'parks', importance: 'nice' }], {}, DEFS, CFG);
    expect(ranked.map((r) => r.input.communityCode)).toEqual(['XXX', 'YYY', 'ZZZ']);
  });

  it('rejects unknown priority keys', () => {
    expect(() => rankCommunities(ALL, [{ key: 'beaches', importance: 'must' }], {}, DEFS, CFG)).toThrow(
      UnknownPriorityError,
    );
  });

  it('formats straight-line distances', () => {
    expect(formatMeters(12)).toBe('50 m');
    expect(formatMeters(437)).toBe('450 m');
    expect(formatMeters(1_000)).toBe('1 km');
    expect(formatMeters(1_840)).toBe('1.8 km');
  });
});

// ── Service ─────────────────────────────────────────────────────────────

const MATCH_CONFIG = loadConfig(TEST_ENV).communityMatch;

function livingFor(code: string, nearest: Record<string, number | null>, level: 'low' | 'moderate' | 'high'): CommunityLivingMetrics {
  return {
    communityCode: code,
    name: code,
    slug: code.toLowerCase(),
    searchRadiusM: 3_000,
    amenities: Object.entries(nearest).map(([category, d]) => ({
      category,
      label: category,
      nearest: d === null ? null : { name: `${category} near ${code}`, distanceM: d },
      counts: [],
    })),
    treeCover: { publicTrees: 100, areaHa: 10, treesPerHa: level === 'high' ? 20 : level === 'moderate' ? 13 : 4, level },
    dataRefreshedAt: '2026-11-01T07:00:00.000Z',
    metrics: {},
  };
}

function fakeDeps(count: number, over: Partial<CommunityMatchServiceDeps> = {}) {
  const calls = { anchors: 0, living: 0, cacheGet: 0, cachePut: 0 };
  const codes = Array.from({ length: count }, (_, i) => `C${String(i).padStart(3, '0')}`);
  const store: CommunityMatchStore = {
    listCommunityAnchors: async () => {
      calls.anchors++;
      return codes.map((code, i) => ({
        communityCode: code,
        name: `Community ${code}`,
        lat: 51,
        lng: -114,
        data: { slug: code.toLowerCase() },
        refreshedAt: new Date(Date.UTC(2026, 10, 1 + (i % 3), 7)),
      }));
    },
    listLotAreas: async () => codes.flatMap((code, i) => Array.from({ length: i % 4 }, (_, j) => ({ communitySlug: code.toLowerCase(), lotSqft: 3_000 + j * 1_500 }))),
    listLotRefreshes: async () => codes.map((code) => ({ communitySlug: code.toLowerCase(), refreshedAt: new Date('2026-11-16T09:30:00Z') })),
    listAvgLotSqft: async () => codes.map((code, i) => ({ communitySlug: code, slug: code.toLowerCase(), avgLotSqft: i % 5 === 0 ? null : 4_000 + i * 10 })),
  };
  const cacheMap = new Map<string, unknown>();
  const deps: CommunityMatchServiceDeps = {
    store,
    designations: {
      listDesignations: async () =>
        codes.flatMap((code, i) =>
          (i % 2 === 0 ? ['K-6', '7-9', '10-12'] : ['K-9']).map((band) => ({
            externalId: `${code}|${band}`,
            communityCode: code,
            gradeBand: band,
            data: {},
            refreshedAt: new Date(),
          })),
        ),
    },
    living: {
      getCommunityLivingMetrics: async (code) => {
        calls.living++;
        const i = codes.indexOf(code);
        return livingFor(code, { parks: (i * 137) % 3_000, libraries: i % 7 === 0 ? null : (i * 251) % 3_000 }, (['low', 'moderate', 'high'] as const)[i % 3]!);
      },
    },
    cache: {
      get: async (dataset, key) => {
        calls.cacheGet++;
        return cacheMap.get(`${dataset}|${key}`);
      },
      put: async (dataset, key, payload) => {
        calls.cachePut++;
        cacheMap.set(`${dataset}|${key}`, JSON.parse(JSON.stringify(payload)));
      },
    },
    costData: PLACEHOLDER_COST_DATA,
    config: MATCH_CONFIG,
    city: 'calgary',
    amenityCategories: CATEGORIES,
    amenitySearchRadiusM: 3_000,
    ...over,
  };
  return { deps, calls, cacheMap };
}

const PRIORITIES: MatchPriority[] = [
  { key: 'parks', importance: 'must' },
  { key: 'tree-cover', importance: 'nice' },
  { key: 'designated-schools', importance: 'nice' },
  { key: 'libraries', importance: 'nice' },
];

describe('community match service', () => {
  it('builds the snapshot once, then serves from memory; a new instance reads the shared cache', async () => {
    const { deps, calls } = fakeDeps(12);
    const service = createCommunityMatchService(deps);
    const first = await service.match({ priorities: PRIORITIES });
    expect(calls).toMatchObject({ anchors: 1, living: 12, cacheGet: 1, cachePut: 1 });
    expect(await service.match({ priorities: PRIORITIES })).toEqual(first);
    expect(calls).toMatchObject({ anchors: 1, living: 12, cacheGet: 1 });

    const second = createCommunityMatchService(deps);
    expect(await second.match({ priorities: PRIORITIES })).toEqual(first);
    expect(calls).toMatchObject({ anchors: 1, living: 12, cacheGet: 2, cachePut: 1 });
  });

  it('concurrent cold requests share one snapshot build', async () => {
    const { deps, calls } = fakeDeps(5);
    const service = createCommunityMatchService(deps);
    await Promise.all(Array.from({ length: 5 }, () => service.match({ priorities: PRIORITIES })));
    expect(calls.anchors).toBe(1);
  });

  it('rebuilds after the memory and cache TTLs expire; empty data is never cached', async () => {
    let now = new Date('2026-11-17T00:00:00Z');
    const { deps, calls } = fakeDeps(3, {
      clock: () => now,
      cache: undefined,
    });
    const service = createCommunityMatchService(deps);
    await service.match({ priorities: PRIORITIES });
    now = new Date(now.getTime() + MATCH_CONFIG.memoryTtlMs + 1);
    await service.match({ priorities: PRIORITIES });
    expect(calls.anchors).toBe(2);

    const empty = fakeDeps(0);
    const emptyService = createCommunityMatchService(empty.deps);
    const res = await emptyService.match({ priorities: PRIORITIES });
    expect(res).toMatchObject({ results: [], total: 0, dataRefreshedAt: null });
    await emptyService.match({ priorities: PRIORITIES });
    expect(empty.calls.anchors).toBe(2);
    expect(empty.calls.cachePut).toBe(0);
  });

  it('prices the typical new-build range with the cost engine on the average lot', async () => {
    const { deps } = fakeDeps(10);
    const res = await createCommunityMatchService(deps).match({ priorities: PRIORITIES, limit: 200 });
    expect(res.buildBasis).toEqual({
      buildSqft: 2_400,
      tier: 'standard',
      costDataVersion: PLACEHOLDER_COST_DATA.version,
      calibrated: PLACEHOLDER_COST_DATA.calibrated,
    });
    for (const r of res.results) {
      const i = Number(r.communityCode.slice(1));
      if (i % 5 === 0) {
        expect(r.typicalNewBuild).toBeNull();
      } else {
        const band = calculateBuildBand(2_400, 4_000 + i * 10, 'standard', PLACEHOLDER_COST_DATA);
        expect(r.typicalNewBuild).toEqual({ low: band.low, high: band.high });
        expect(r.typicalNewBuild!.low).toBeLessThan(r.typicalNewBuild!.high);
      }
    }
    expect(res).toMatchObject({
      distanceBasis: 'straight-line',
      frontageBasis: 'estimated-from-lot-area',
      dataRefreshedAt: '2026-11-03T07:00:00.000Z',
    });
    // No per-sqft rates or margins in the public payload.
    const keys = JSON.stringify(res).match(/"[a-zA-Z]+":/g) ?? [];
    expect(keys.filter((k) => /"(rate|rates|margin|margins|perSqft|ratePerSqft)":/i.test(k))).toEqual([]);
  });

  it('maps lot counts, designations and limit; reasons + must misses on every result', async () => {
    const { deps } = fakeDeps(20);
    const service = createCommunityMatchService(deps);
    const res = await service.match({
      priorities: PRIORITIES,
      filters: { minFrontageFt: 30, lotsListedNow: true },
      limit: 4,
    });
    // i % 4 lots each: 0 lots → dropped; 3000 sqft = 25 ft fails, 4500+ = 37.5+ ft passes.
    expect(res.total).toBe(10); // i%4 in {2,3} for 20 communities
    expect(res.results).toHaveLength(4);
    expect(res.results.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    for (const r of res.results) {
      expect(r.reasons.length).toBeGreaterThanOrEqual(1);
      expect(r.lots.matching).toBeGreaterThan(0);
      expect(r.lots.refreshedAt).toBe('2026-11-16T09:30:00.000Z');
      expect(r.passesMustHaves).toBe(!r.misses.some((m) => m.importance === 'must'));
    }
    // Passing communities first.
    const passes = res.results.map((r) => r.passesMustHaves);
    expect([...passes].sort((a, b) => Number(b) - Number(a))).toEqual(passes);
    expect(service.priorities().map((p) => p.key)).toEqual(['parks', 'libraries', 'tree-cover', 'designated-schools']);
  });

  it('AC3: scores 110 communities in well under 300 ms at p95 once the snapshot is warm', async () => {
    const { deps } = fakeDeps(110);
    const service = createCommunityMatchService(deps);
    const cold = await service.match({ priorities: PRIORITIES, limit: 200 });
    expect(cold.total).toBe(110);
    const timings: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      await service.match({ priorities: PRIORITIES, filters: { minFrontageFt: 30 }, limit: 200 });
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    expect(timings[Math.floor(timings.length * 0.95)]!).toBeLessThan(300);
  });
});

// ── Route ───────────────────────────────────────────────────────────────

describe('community match route', () => {
  const { deps } = fakeDeps(3);
  const route = createCommunityMatchRoute({ communityMatch: createCommunityMatchService(deps) });

  async function status(body: unknown): Promise<number | 'ok'> {
    try {
      await route.handle(body);
      return 'ok';
    } catch (error) {
      if (error instanceof HttpError) return error.status;
      throw error;
    }
  }

  it('accepts an object or a JSON string body', async () => {
    const body = { priorities: [{ key: 'parks', importance: 'must' }] };
    expect(await status(body)).toBe('ok');
    expect(await status(JSON.stringify(body))).toBe('ok');
  });

  it.each([
    ['no body', undefined],
    ['bad JSON', '{'],
    ['no priorities', { priorities: [] }],
    ['bad importance', { priorities: [{ key: 'parks', importance: 'maybe' }] }],
    ['duplicate keys', { priorities: [{ key: 'parks', importance: 'must' }, { key: 'parks', importance: 'nice' }] }],
    ['extra field', { priorities: [{ key: 'parks', importance: 'must' }], sort: 'x' }],
    ['negative frontage', { priorities: [{ key: 'parks', importance: 'must' }], filters: { minFrontageFt: -1 } }],
    ['bad limit', { priorities: [{ key: 'parks', importance: 'must' }], limit: 0 }],
  ])('400 for %s', async (_label, body) => {
    expect(await status(body)).toBe(400);
  });

  it('400 for an unknown priority, naming the known ones', async () => {
    await expect(route.handle({ priorities: [{ key: 'beaches', importance: 'must' }] })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Known priorities: parks, libraries, tree-cover, designated-schools'),
    });
  });
});

// ── End to end on PGlite ────────────────────────────────────────────────

describe('community match end to end (PGlite, real composition)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('ranks stored communities from our tables and caches the snapshot', async () => {
    const neighbourhood = createDrizzleNeighbourhoodDataStore({ db: testDb.db });
    await neighbourhood.replaceSnapshot(
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
        {
          externalId: 'tree-cover|bnf',
          category: 'tree-cover',
          name: 'BANFF TRAIL',
          communityCode: 'BNF',
          lat: 51.0750,
          lng: -114.1150,
          data: { slug: 'banff-trail', publicTrees: 500, areaHa: 100, treesPerHa: 5 },
        },
        // ~300 m north of Altadore's centre.
        { externalId: 'p1', category: 'parks', name: 'Near Park', lat: 51.0164, lng: -114.0983, data: {} },
      ],
      new Date('2026-11-01T07:00:00Z'),
    );
    await testDb.exec(`
      insert into community_lots (id, city, community_slug, roll_number, address, lot_sqft, assessed_value, roll_year, district_source)
      values ('calgary:1', 'calgary', 'altadore', '1', '1 ST SW', 6000, 900000, '2026', 'land-use-districts'),
             ('calgary:2', 'calgary', 'banff-trail', '2', '2 ST NW', 3000, 600000, '2026', 'land-use-districts');
      insert into community_lot_refreshes (id, city, community_slug, community_name, roll_year, lot_count, refreshed_at)
      values ('calgary:altadore', 'calgary', 'altadore', 'ALTADORE', '2026', 1, '2026-11-16T09:30:00Z');
      insert into community_stats (slug, name, avg_assessed_value, assessment_count, avg_lot_sqft, refreshed_at)
      values ('altadore', 'Altadore', 900000, 500, 5500, '2026-11-01T00:00:00Z');
    `);

    // Store reads (the whole-city queries).
    const store = createDrizzleCommunityMatchStore({ db: testDb.db });
    expect((await store.listCommunityAnchors()).map((a) => a.communityCode)).toEqual(['ALT', 'BNF']);
    expect(await store.listLotRefreshes('calgary')).toHaveLength(1);

    const app = createComposition(TEST_ENV, {
      neighbourhoodDataStore: neighbourhood,
      cityDataCacheStore: createDrizzleCityDataCacheStore({ db: testDb.db }),
      communityMatchStore: store,
    });
    const res = await app.communityMatchRoute.handle({
      priorities: [
        { key: 'parks', importance: 'must' },
        { key: 'tree-cover', importance: 'nice' },
      ],
      filters: { minFrontageFt: 40 },
    });
    expect(res.results.map((r) => [r.rank, r.slug, r.passesMustHaves])).toEqual([
      [1, 'altadore', true],
      [2, 'banff-trail', false],
    ]);
    const [alt, bnf] = res.results;
    expect(alt!.match).toBe(100);
    expect(alt!.lots).toEqual({ listed: 1, matching: 1, refreshedAt: '2026-11-16T09:30:00.000Z' });
    const band = calculateBuildBand(2_400, 5_500, 'standard', PLACEHOLDER_COST_DATA);
    expect(alt!.typicalNewBuild).toEqual({ low: band.low, high: band.high });
    expect(bnf!.misses[0]).toMatchObject({ priority: 'parks', importance: 'must' });
    expect(bnf!.lots).toEqual({ listed: 1, matching: 0, refreshedAt: null });
    expect(bnf!.typicalNewBuild).toBeNull();
    expect(res.dataRefreshedAt).toBe('2026-11-01T07:00:00.000Z');

    const cached = await testDb.rows(
      `select dataset_id from city_data_cache where dataset_id = '${COMMUNITY_MATCH_CACHE_DATASET}'`,
    );
    expect(cached).toHaveLength(1);
  });
});
