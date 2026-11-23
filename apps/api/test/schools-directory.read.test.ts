/**
 * Schools directory end to end (#774) on PGlite with the REAL composition:
 * the free provider (fed by fake City / OSM responses) fills `schools`
 * through the monthly refresh, then the public route serves it.
 *
 * - AC1: every school has a type; private + charter flagged.
 * - AC2: filtering by type returns only that type.
 * - AC3: source attribution is stored and returned.
 * - Serving reads makes zero outside calls (epic rule).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHOOL_TYPES } from '@feasly/contracts';
import { createComposition } from '../src/composition';
import { loadConfig } from '../src/config';
import { createDrizzleNeighbourhoodDataStore } from '../src/services/neighbourhood-data/neighbourhood-data.store';
import { createNeighbourhoodProviders, type FetchLike } from '../src/services/neighbourhood-data/providers';
import { createTestDb, type TestDb } from './pglite-db';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

function cityRow(id: string, name: string, board: string, lng: number, lat: number) {
  return {
    global_id: `{${id}}`,
    name,
    board,
    address_ab: `${id} ST SW`,
    grades: 'Elementary',
    elem: 'Y',
    junior_h: 'N',
    senior_h: 'N',
    postsecond: 'N',
    point: { type: 'Point', coordinates: [lng, lat] },
  };
}

const RESPONSES: Record<string, unknown> = {
  'fd9t-tdn2': [
    cityRow('A1', 'Altadore School', 'The Calgary School Division', -114.098, 51.012),
    cityRow('B2', 'Holy Name School', 'The Calgary Roman Catholic Separate School Division', -114.09, 51.02),
    cityRow('C3', 'Westmount Charter School', 'Westmount Charter School Society', -114.15, 51.08),
    cityRow('D4', 'Rundle Academy', 'Rundle College Society', -114.2, 51.1),
  ],
  'surr-xmvs': [
    {
      comm_code: 'ALT',
      name: 'ALTADORE',
      multipolygon: {
        type: 'MultiPolygon',
        coordinates: [[[[-114.11, 51.0], [-114.08, 51.0], [-114.08, 51.03], [-114.11, 51.03], [-114.11, 51.0]]]],
      },
    },
  ],
  overpass: {
    elements: [
      {
        type: 'node',
        id: 42,
        lat: 51.015,
        lon: -114.1,
        tags: { amenity: 'school', name: 'Little Oak Montessori', 'operator:type': 'private', grades: 'K-6', website: 'https://oak.example' },
      },
    ],
  },
};

describe('schools directory end to end (#774)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('refresh stores the typed directory; the route filters by type and community and returns attribution', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      const key = Object.keys(RESPONSES).find(
        (k) => url.includes(`/resource/${k}.json`) || (k === 'overpass' && url.includes('overpass')),
      );
      return { ok: key !== undefined, status: key ? 200 : 404, json: async () => (key ? RESPONSES[key] : {}) };
    };
    const app = createComposition(TEST_ENV, {
      neighbourhoodDataStore: createDrizzleNeighbourhoodDataStore({ db: testDb.db }),
      neighbourhoodProviders: createNeighbourhoodProviders(loadConfig(TEST_ENV).neighbourhoodData, { fetchImpl }),
    });

    const refresh = await app.neighbourhoodRefreshService.refreshNow('school-directory');
    expect(refresh).toMatchObject({ outcome: 'ok' });
    // Re-run is idempotent: nothing changes.
    expect(await app.neighbourhoodRefreshService.refreshNow('school-directory')).toMatchObject({
      outcome: 'ok',
      rowsChanged: 0,
    });
    const calls = urls.length;

    // AC1 — every school typed; private + charter flagged.
    const all = await app.schoolsRoute.list(undefined);
    expect(all.schools.map((s) => [s.name, s.type])).toEqual([
      ['Altadore School', 'public_cbe'],
      ['Holy Name School', 'catholic_ccsd'],
      ['Little Oak Montessori', 'private'],
      ['Rundle Academy', 'private'],
      ['Westmount Charter School', 'charter'],
    ]);
    expect(all.schools.every((s) => SCHOOL_TYPES.includes(s.type))).toBe(true);
    expect(all.schools.find((s) => s.name === 'Rundle Academy')!.tuition).toBe(true);

    // AC2 — filtering by type returns only that type.
    for (const type of SCHOOL_TYPES) {
      const res = await app.schoolsRoute.list({ type });
      expect(res.schools.every((s) => s.type === type), type).toBe(true);
    }
    expect((await app.schoolsRoute.list({ type: 'private' })).schools.map((s) => s.name)).toEqual([
      'Little Oak Montessori',
      'Rundle Academy',
    ]);
    expect((await app.schoolsRoute.list({ type: 'charter' })).schools.map((s) => s.id)).toEqual(['city-c3']);
    // Community filter (case-insensitive code), combined with type.
    expect((await app.schoolsRoute.list({ community: 'alt' })).schools.map((s) => s.name)).toEqual([
      'Altadore School',
      'Holy Name School',
      'Little Oak Montessori',
    ]);
    expect(
      (await app.schoolsRoute.list({ community: 'ALT', type: 'private' })).schools.map((s) => s.name),
    ).toEqual(['Little Oak Montessori']);

    // AC3 — attribution stored and returned (per field + notices).
    const stored = await testDb.rows<{ data: { sources: Record<string, string> } }>(
      "select data from schools where external_id = 'osm-node-42'",
    );
    expect(stored[0]!.data.sources['website']).toBe('openstreetmap');
    const one = await app.schoolsRoute.get('osm-node-42');
    expect(one.school).toMatchObject({
      name: 'Little Oak Montessori',
      type: 'private',
      website: 'https://oak.example/',
      programs: ['montessori'],
      communityCode: 'ALT',
      sources: { name: 'openstreetmap', website: 'openstreetmap', community: 'calgary-open-data' },
    });
    expect(one.attributions.map((a) => a.id)).toEqual(['calgary-open-data', 'openstreetmap']);
    expect(all.attributions.map((a) => a.id)).toEqual([
      'calgary-open-data',
      'alberta-authority-list',
      'openstreetmap',
    ]);
    expect(one.disclaimer).toMatch(/confirm/i);
    await expect(app.schoolsRoute.get('city-nope')).rejects.toMatchObject({ status: 404 });

    // Serving reads made no outside call.
    expect(urls.length).toBe(calls);
  });

  it('the read service and route have no path to a provider (static)', () => {
    const src = join(__dirname, '..', 'src');
    for (const file of [
      'services/neighbourhood-data/school-directory-read.service.ts',
      'routes/schools.route.ts',
    ]) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toMatch(/providers'|neighbourhood-refresh\.service|school-directory'/);
    }
  });
});
