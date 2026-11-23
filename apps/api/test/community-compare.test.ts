/**
 * Community compare (#780).
 *
 * - Pure rows: schools per grade group, nearest amenities, tree cover and
 *   building-here rows; best value per row marked on the server (ties all
 *   marked, nothing when equal / missing / no direction).
 * - Service: communities in the order asked, cost-engine build ranges,
 *   unknown slugs rejected, snapshot shared with match.
 * - Route: 2..compareMax unique kebab slugs; 404 for an unknown community.
 */
import { describe, expect, it } from 'vitest';
import { calculateBuildBand, PLACEHOLDER_COST_DATA } from '@feasly/cost-engine';
import { loadConfig } from '../src/config';
import { HttpError } from '../src/middleware/errors';
import { createCommunityCompareRoute } from '../src/routes/community-compare.route';
import {
  COMMUNITY_COMPARE_DISCLAIMER,
  createCommunityMatchService,
  UnknownCommunityError,
  type CommunityMatchServiceDeps,
} from '../src/services/community-match/community-match.service';
import {
  buildCompareRows,
  markBest,
  type CompareCommunityInput,
} from '../src/services/community-match/compare';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;
const MATCH_CONFIG = loadConfig(TEST_ENV).communityMatch;

const CATEGORIES = [
  { key: 'parks', label: 'Parks' },
  { key: 'pathways', label: 'Pathways' },
];
const CFG = { amenityCategories: CATEGORIES, searchRadiusM: 3_000 };

function input(over: Partial<CompareCommunityInput> & { slug: string }): CompareCommunityInput {
  return {
    communityCode: over.slug.toUpperCase(),
    name: over.slug,
    amenityNearestM: {},
    treeCover: null,
    designatedBands: [],
    lotSqft: [],
    lotsRefreshedAt: null,
    avgLotSqft: null,
    typicalNewBuild: null,
    ...over,
  };
}

describe('community compare rows (pure)', () => {
  const a = input({
    slug: 'a',
    amenityNearestM: { parks: 420, pathways: null },
    treeCover: { level: 'high', treesPerHa: 18.4 },
    designatedBands: ['K-6', '7-9', '10-12'],
    lotSqft: [3_000, 4_500],
    avgLotSqft: 5_200,
    typicalNewBuild: { low: 900_000, high: 1_100_000 },
  });
  const b = input({
    slug: 'b',
    amenityNearestM: { parks: 900, pathways: 300 },
    treeCover: { level: 'low', treesPerHa: 4 },
    designatedBands: ['K-9'],
    lotSqft: [3_000, 4_500],
    avgLotSqft: 4_100,
    typicalNewBuild: { low: 850_000, high: 1_000_000 },
  });
  const rows = buildCompareRows([a, b], CFG);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  it('emits school, amenity, tree-cover and building rows in a stable order', () => {
    expect(rows.map((r) => r.key)).toEqual([
      'schools-k-6',
      'schools-7-9',
      'schools-10-12',
      'amenity-parks',
      'amenity-pathways',
      'tree-cover',
      'lots-listed',
      'avg-lot-size',
      'typical-new-build',
    ]);
    expect(byKey.get('schools-k-6')).toMatchObject({ kind: 'schools', priority: 'designated-schools', label: 'Elementary (K–6)' });
    expect(byKey.get('amenity-parks')).toMatchObject({ kind: 'amenity', priority: 'parks', label: 'Parks' });
    expect(byKey.get('tree-cover')).toMatchObject({ kind: 'tree-cover', priority: 'tree-cover' });
    expect(byKey.get('lots-listed')).toMatchObject({ kind: 'building', priority: null });
    for (const row of rows) expect(row.cells).toHaveLength(2);
  });

  it('marks the best value per row: nearest amenity, most trees, school on file', () => {
    expect(byKey.get('amenity-parks')!.cells).toEqual([
      { text: 'Nearest about 400 m', best: true },
      { text: 'Nearest about 900 m', best: false },
    ]);
    // A missing value never wins, and the present one does.
    expect(byKey.get('amenity-pathways')!.cells).toEqual([
      { text: 'None within 3 km', best: false },
      { text: 'Nearest about 300 m', best: true },
    ]);
    expect(byKey.get('tree-cover')!.cells.map((c) => [c.text, c.best])).toEqual([
      ['High (18 City trees per hectare)', true],
      ['Low (4 City trees per hectare)', false],
    ]);
    // K-9 covers elementary and junior high; only a has a high school.
    expect(byKey.get('schools-k-6')!.cells.map((c) => c.best)).toEqual([false, false]);
    expect(byKey.get('schools-10-12')!.cells).toEqual([
      { text: 'Typically designated school on file', best: true },
      { text: 'None on file', best: false },
    ]);
  });

  it('marks nothing when values tie across every column; the build range is never marked', () => {
    expect(byKey.get('lots-listed')!.cells).toEqual([
      { text: '2 lots', best: false },
      { text: '2 lots', best: false },
    ]);
    expect(byKey.get('avg-lot-size')!.cells.map((c) => [c.text, c.best])).toEqual([
      ['5,200 sq ft', true],
      ['4,100 sq ft', false],
    ]);
    expect(byKey.get('typical-new-build')!.cells).toEqual([
      { text: '$900,000–$1,100,000', best: false, range: { low: 900_000, high: 1_100_000 } },
      { text: '$850,000–$1,000,000', best: false, range: { low: 850_000, high: 1_000_000 } },
    ]);
  });

  it('missing data reads plainly', () => {
    const empty = buildCompareRows([input({ slug: 'x' }), input({ slug: 'y', lotSqft: [3_000] })], CFG);
    const get = (key: string) => empty.find((r) => r.key === key)!.cells;
    expect(get('tree-cover')[0]!.text).toBe('No data on file');
    expect(get('lots-listed')).toEqual([
      { text: 'None listed right now', best: false },
      { text: '1 lot', best: true },
    ]);
    expect(get('avg-lot-size')[0]!.text).toBe('No lot-size data yet');
    expect(get('typical-new-build')[0]).toEqual({ text: 'No lot-size data yet', best: false });
  });

  it('markBest: ties all marked, all-equal and all-missing mark nothing', () => {
    const cells = (values: (number | null)[]) => values.map((value) => ({ text: String(value), value }));
    expect(markBest(cells([3, 3, 1]), 'higher').map((c) => c.best)).toEqual([true, true, false]);
    expect(markBest(cells([2, 2, 2]), 'higher').map((c) => c.best)).toEqual([false, false, false]);
    expect(markBest(cells([2, 2, null]), 'higher').map((c) => c.best)).toEqual([true, true, false]);
    expect(markBest(cells([null, null]), 'lower').map((c) => c.best)).toEqual([false, false]);
    expect(markBest(cells([5, 1]), 'none').map((c) => c.best)).toEqual([false, false]);
  });
});

// ── Service + route ─────────────────────────────────────────────────────

function deps(): CommunityMatchServiceDeps {
  const communities = [
    { code: 'ALT', name: 'ALTADORE', slug: 'altadore', parks: 300, avg: 5_000 },
    { code: 'KIL', name: 'KILLARNEY/GLENGARRY', slug: 'killarney-glengarry', parks: 800, avg: 4_200 },
    { code: 'MRP', name: 'MARDA LOOP', slug: 'marda-loop', parks: null, avg: null },
    { code: 'BNF', name: 'BANFF TRAIL', slug: 'banff-trail', parks: 500, avg: 4_000 },
  ];
  return {
    store: {
      listCommunityAnchors: async () =>
        communities.map((c) => ({
          communityCode: c.code,
          name: c.name,
          lat: 51,
          lng: -114,
          data: { slug: c.slug },
          refreshedAt: new Date('2026-11-01T07:00:00Z'),
        })),
      listLotAreas: async () => [{ communitySlug: 'altadore', lotSqft: 3_000 }],
      listLotRefreshes: async () => [],
      listAvgLotSqft: async () => communities.map((c) => ({ slug: c.slug, avgLotSqft: c.avg })),
    },
    designations: { listDesignations: async () => [] },
    living: {
      getCommunityLivingMetrics: async (code) => {
        const c = communities.find((x) => x.code === code)!;
        return {
          communityCode: code,
          name: c.name,
          slug: c.slug,
          searchRadiusM: 3_000,
          amenities: [
            {
              category: 'parks',
              label: 'Parks',
              nearest: c.parks === null ? null : { name: 'Park', distanceM: c.parks },
              counts: [],
            },
          ],
          treeCover: null,
          dataRefreshedAt: '2026-11-01T07:00:00.000Z',
          metrics: {},
        };
      },
    },
    costData: PLACEHOLDER_COST_DATA,
    config: MATCH_CONFIG,
    city: 'calgary',
    amenityCategories: CATEGORIES,
    amenitySearchRadiusM: 3_000,
  };
}

describe('community compare service', () => {
  const service = createCommunityMatchService(deps());

  it('returns the communities in the order asked, with cost-engine build ranges', async () => {
    const res = await service.compare(['killarney-glengarry', 'altadore', 'marda-loop']);
    expect(res.communities.map((c) => c.slug)).toEqual(['killarney-glengarry', 'altadore', 'marda-loop']);
    expect(res.communities[0]).toEqual({ communityCode: 'KIL', name: 'KILLARNEY/GLENGARRY', slug: 'killarney-glengarry' });
    const parks = res.rows.find((r) => r.key === 'amenity-parks')!;
    expect(parks.cells.map((c) => c.best)).toEqual([false, true, false]);
    const build = res.rows.find((r) => r.key === 'typical-new-build')!;
    const band = calculateBuildBand(MATCH_CONFIG.buildSqft, 4_200, MATCH_CONFIG.buildTier, PLACEHOLDER_COST_DATA);
    expect(build.cells[0]!.range).toEqual({ low: band.low, high: band.high });
    expect(build.cells[2]).toEqual({ text: 'No lot-size data yet', best: false });
    expect(res).toMatchObject({
      distanceBasis: 'straight-line',
      dataRefreshedAt: '2026-11-01T07:00:00.000Z',
      disclaimer: COMMUNITY_COMPARE_DISCLAIMER,
      buildBasis: { buildSqft: MATCH_CONFIG.buildSqft, costDataVersion: PLACEHOLDER_COST_DATA.version },
    });
  });

  it('rejects a slug that is not an established community we cover', async () => {
    await expect(service.compare(['altadore', 'nowhere'])).rejects.toBeInstanceOf(UnknownCommunityError);
  });

  it('disclaimer says designations can change and estimates are not quotes', () => {
    expect(COMMUNITY_COMPARE_DISCLAIMER).toMatch(/designations can change/);
    expect(COMMUNITY_COMPARE_DISCLAIMER).toMatch(/not quotes/);
  });
});

describe('community compare route', () => {
  const route = createCommunityCompareRoute({
    communityMatch: createCommunityMatchService(deps()),
    compareMax: 3,
  });

  async function status(query: Record<string, string | undefined> | undefined): Promise<number | 'ok'> {
    try {
      await route.handle(query);
      return 'ok';
    } catch (error) {
      if (error instanceof HttpError) return error.status;
      throw error;
    }
  }

  it('accepts 2 or 3 slugs', async () => {
    expect(await status({ slugs: 'altadore,killarney-glengarry' })).toBe('ok');
    expect(await status({ slugs: 'altadore, killarney-glengarry ,marda-loop' })).toBe('ok');
  });

  it.each([
    ['no query', undefined],
    ['no slugs', {}],
    ['one slug', { slugs: 'altadore' }],
    ['too many', { slugs: 'altadore,killarney-glengarry,marda-loop,banff-trail' }],
    ['duplicates', { slugs: 'altadore,altadore' }],
    ['bad slug', { slugs: 'altadore,Marda Loop' }],
  ])('400 for %s', async (_label, query) => {
    expect(await status(query)).toBe(400);
  });

  it('404 for an unknown community, naming it', async () => {
    await expect(route.handle({ slugs: 'altadore,nowhere' })).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('nowhere'),
    });
  });
});
