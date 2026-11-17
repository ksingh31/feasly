/**
 * School ratings + reviews link (#776) against PGlite with the REAL
 * composition.
 *
 * AC1: a school with a Fraser listing returns score + year + source URL;
 *      one without returns null.
 * AC2: with the Fraser flag off, no Fraser data is returned (and none is
 *      stored by the refresh).
 * AC3: with the free reviews provider the reviews field is a link only —
 *      no outside call, nothing stored.
 * Also: curated-list validation, provider selection by config, provincial
 * results + enrolment, malformed stored data served as null.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SchoolResponseSchema, SchoolsListResponseSchema } from '../src/openapi/schemas';
import { createComposition } from '../src/composition';
import { loadConfig } from '../src/config';
import {
  createNeighbourhoodProviders,
  createPublishedReportsRatingsProvider,
  type FetchLike,
  type NeighbourhoodProviders,
  type SchoolRecord,
} from '../src/services/neighbourhood-data/providers';
import { createDrizzleNeighbourhoodDataStore } from '../src/services/neighbourhood-data/neighbourhood-data.store';
import {
  buildRatingRecords,
  InvalidSchoolRatingError,
  type CuratedSchoolRating,
} from '../src/services/neighbourhood-data/school-ratings';
import { PUBLISHED_SCHOOL_RATINGS } from '../src/services/neighbourhood-data/school-ratings.data';
import { createMapsReviewsLinker } from '../src/lib/school-ratings';
import { createTestDb, type TestDb } from './pglite-db';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

const FRASER_URL = 'https://www.compareschoolrankings.org/school/alberta/0001';
const AB_URL = 'https://www.alberta.ca/provincial-achievement-test-results';
const CBE_URL = 'https://www.cbe.ab.ca/enrolment-report.pdf';

/** Test fixture — illustrative figures, not real published results. */
const ENTRIES: CuratedSchoolRating[] = [
  { kind: 'fraser', schoolId: 'city-a1', score: 7.4, year: '2025', sourceUrl: FRASER_URL },
  {
    kind: 'provincial',
    schoolId: 'city-a1',
    schoolYear: '2024-25',
    tests: [{ test: 'pat6', acceptableStandardPct: 81.5, excellenceStandardPct: null }],
    sourceUrl: AB_URL,
  },
  { kind: 'enrolment', schoolId: 'city-a1', schoolYear: '2025-26', enrolment: 450, capacity: 500, sourceUrl: CBE_URL },
];

function school(externalId: string, name: string, address: string): SchoolRecord {
  return {
    externalId,
    name,
    board: 'Calgary Board of Education',
    grades: 'Elementary',
    schoolType: 'public_cbe',
    communityCode: 'ALT',
    lat: 51.01,
    lng: -114.1,
    data: { address, sources: { name: 'calgary-open-data' } },
  };
}

describe('school ratings curated list (#776)', () => {
  it('builds one record per school and kind with its source', () => {
    const records = buildRatingRecords(ENTRIES, { fraserEnabled: true });
    expect(records.map((r) => r.externalId)).toEqual(['fraser|city-a1', 'provincial|city-a1', 'enrolment|city-a1']);
    expect(records[0]).toMatchObject({ schoolRef: 'city-a1', rating: 7.4, period: '2025' });
    expect(records.every((r) => typeof r.data['sourceUrl'] === 'string')).toBe(true);
  });

  it('drops Fraser entries when the flag is off (AC2)', () => {
    const records = buildRatingRecords(ENTRIES, { fraserEnabled: false });
    expect(records.map((r) => r.data['kind'])).toEqual(['provincial', 'enrolment']);
  });

  it.each<[string, CuratedSchoolRating]>([
    ['score out of range', { ...(ENTRIES[0] as CuratedSchoolRating & { kind: 'fraser' }), score: 11 }],
    ['bad year', { ...(ENTRIES[0] as CuratedSchoolRating & { kind: 'fraser' }), year: '25' }],
    ['non-https source', { ...ENTRIES[0]!, sourceUrl: 'http://example.com' }],
    ['missing school', { ...ENTRIES[0]!, schoolId: ' ' }],
    ['zero capacity', { ...(ENTRIES[2] as CuratedSchoolRating & { kind: 'enrolment' }), capacity: 0 }],
    [
      'percent out of range',
      {
        ...(ENTRIES[1] as CuratedSchoolRating & { kind: 'provincial' }),
        tests: [{ test: 'pat9', acceptableStandardPct: 120, excellenceStandardPct: null }],
      },
    ],
  ])('rejects %s', (_label, entry) => {
    expect(() => buildRatingRecords([entry], { fraserEnabled: true })).toThrow(InvalidSchoolRatingError);
  });

  it('rejects a duplicated school + kind', () => {
    expect(() => buildRatingRecords([ENTRIES[0]!, ENTRIES[0]!], { fraserEnabled: true })).toThrow(/duplicate/);
  });

  it('the shipped curated list is valid', () => {
    expect(() => buildRatingRecords(PUBLISHED_SCHOOL_RATINGS, { fraserEnabled: true })).not.toThrow();
  });
});

describe('provider selection by config (#776)', () => {
  it('defaults: ratings off until the list is filled; reviews = maps-link storing nothing', () => {
    const config = loadConfig(BASE_ENV).neighbourhoodData;
    expect(config.schoolRatingsFraserEnabled).toBe(false);
    const providers = createNeighbourhoodProviders(config);
    expect(providers.schoolRatings.implementation).toBe('none');
    expect(providers.reviews).toMatchObject({ implementation: 'maps-link', storesNothing: true });
  });

  it('published-reports and none are config-only switches', () => {
    const on = loadConfig({
      ...BASE_ENV,
      NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER: 'published-reports',
      NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED: 'true',
      NEIGHBOURHOOD_REVIEWS_PROVIDER: 'none',
    }).neighbourhoodData;
    expect(on.schoolRatingsFraserEnabled).toBe(true);
    const providers = createNeighbourhoodProviders(on);
    expect(providers.schoolRatings.implementation).toBe('published-reports');
    expect(providers.reviews.implementation).toBe('none');
  });
});

describe('school ratings end to end (#776)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    await testDb.exec('delete from school_ratings; delete from schools; delete from neighbourhood_refresh_state');
  });

  function app(env: Record<string, string>) {
    const fetchCalls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      fetchCalls.push(url);
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const fullEnv = { ...BASE_ENV, ...env } as NodeJS.ProcessEnv;
    const config = loadConfig(fullEnv).neighbourhoodData;
    const base = createNeighbourhoodProviders(config, { fetchImpl });
    const providers: NeighbourhoodProviders = {
      ...base,
      schoolRatings: createPublishedReportsRatingsProvider(
        { fraserEnabled: config.schoolRatingsFraserEnabled },
        ENTRIES,
      ),
    };
    const store = createDrizzleNeighbourhoodDataStore({ db: testDb.db });
    const composition = createComposition(fullEnv, {
      neighbourhoodDataStore: store,
      neighbourhoodProviders: providers,
    });
    return { composition, store, fetchCalls };
  }

  async function seedDirectory(store: ReturnType<typeof createDrizzleNeighbourhoodDataStore>) {
    await store.replaceSnapshot(
      'school-directory',
      'free-public',
      [school('city-a1', 'Altadore School', '4506 16 ST SW'), school('city-b2', 'Elboya School', '4804 6 ST SW')],
      new Date('2026-11-01T00:00:00Z'),
    );
  }

  it('AC1: listed school returns Fraser score + year + source URL; unlisted returns null', async () => {
    const { composition, store } = app({ NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED: 'true' });
    await seedDirectory(store);
    expect(await composition.neighbourhoodRefreshService.refreshNow('school-ratings')).toMatchObject({
      outcome: 'ok',
      rowsTotal: 3,
    });

    const list = await composition.schoolsRoute.list(undefined);
    expect(() => SchoolsListResponseSchema.parse(list)).not.toThrow();
    const a1 = list.schools.find((s) => s.id === 'city-a1')!;
    const b2 = list.schools.find((s) => s.id === 'city-b2')!;
    expect(a1.ratings.fraser).toEqual({
      score: 7.4,
      year: '2025',
      sourceUrl: FRASER_URL,
      attribution: expect.stringContaining('Fraser Institute'),
    });
    expect(a1.ratings.provincialResults).toEqual({
      schoolYear: '2024-25',
      tests: [{ test: 'pat6', acceptableStandardPct: 81.5, excellenceStandardPct: null }],
      sourceUrl: AB_URL,
      attribution: expect.stringContaining('Alberta Education'),
    });
    expect(a1.ratings.enrolment).toMatchObject({ enrolment: 450, capacity: 500, utilizationPct: 90, sourceUrl: CBE_URL });
    expect(b2.ratings).toEqual({ fraser: null, provincialResults: null, enrolment: null });

    const one = await composition.schoolsRoute.get('city-a1');
    expect(() => SchoolResponseSchema.parse(one)).not.toThrow();
    expect(one.school.ratings.fraser?.score).toBe(7.4);
  });

  it('AC2: with the Fraser flag off, no Fraser data is stored or returned', async () => {
    const { composition, store } = app({ NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED: 'false' });
    await seedDirectory(store);
    await composition.neighbourhoodRefreshService.refreshNow('school-ratings');
    expect(await testDb.rows("select id from school_ratings where data->>'kind' = 'fraser'")).toHaveLength(0);
    const a1 = (await composition.schoolsRoute.get('city-a1')).school;
    expect(a1.ratings.fraser).toBeNull();
    expect(a1.ratings.enrolment).not.toBeNull();
    expect(JSON.stringify(a1)).not.toMatch(/fraser institute|compareschoolrankings/i);
  });

  it('AC2: Fraser rows stored while the flag was on are hidden once it is turned off', async () => {
    const on = app({ NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED: 'true' });
    await seedDirectory(on.store);
    await on.composition.neighbourhoodRefreshService.refreshNow('school-ratings');
    const off = app({ NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED: 'false' });
    expect((await off.composition.schoolsRoute.get('city-a1')).school.ratings.fraser).toBeNull();
  });

  it('AC3: free reviews provider returns a link only — no outside call, nothing stored', async () => {
    const { composition, store, fetchCalls } = app({});
    await seedDirectory(store);
    const refresh = await composition.neighbourhoodRefreshService.refreshNow('reviews');
    expect(refresh).toMatchObject({ implementation: 'maps-link', outcome: 'skipped', rowsTotal: 0 });
    expect(await testDb.rows("select id from community_living_metrics where metric = 'reviews'")).toHaveLength(0);

    const a1 = (await composition.schoolsRoute.get('city-a1')).school;
    expect(a1.reviews).toEqual({
      kind: 'link',
      provider: 'google-maps',
      label: 'Read reviews on Google Maps',
      url: expect.stringMatching(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/),
    });
    expect(Object.keys(a1.reviews!).sort()).toEqual(['kind', 'label', 'provider', 'url']);
    expect(new URL(a1.reviews!.url).searchParams.get('query')).toBe('Altadore School, 4506 16 ST SW, Calgary AB');
    expect(fetchCalls).toEqual([]);
  });

  it('reviews provider none → reviews null', async () => {
    const { composition, store } = app({ NEIGHBOURHOOD_REVIEWS_PROVIDER: 'none' });
    await seedDirectory(store);
    expect((await composition.schoolsRoute.get('city-a1')).school.reviews).toBeNull();
  });

  it('malformed or unsourced stored figures are served as null, never patched', async () => {
    const { composition, store } = app({ NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED: 'true' });
    await seedDirectory(store);
    await store.replaceSnapshot(
      'school-ratings',
      'published-reports',
      [
        { externalId: 'fraser|city-a1', schoolRef: 'city-a1', rating: 12, period: '2025', data: { kind: 'fraser', score: 12, year: '2025', sourceUrl: FRASER_URL } },
        { externalId: 'enrolment|city-a1', schoolRef: 'city-a1', rating: null, period: '2025-26', data: { kind: 'enrolment', schoolYear: '2025-26', enrolment: 400, capacity: 500 } },
      ],
      new Date('2026-11-01T00:00:00Z'),
    );
    const a1 = (await composition.schoolsRoute.get('city-a1')).school;
    expect(a1.ratings).toEqual({ fraser: null, provincialResults: null, enrolment: null });
  });
});

describe('maps reviews linker (#776)', () => {
  it('builds on the configured search URL and skips a missing address', () => {
    const link = createMapsReviewsLinker('https://maps.example/search?api=1')({ name: 'X School', address: null });
    expect(link!.url).toBe('https://maps.example/search?api=1&query=X+School%2C+Calgary+AB');
  });
});
