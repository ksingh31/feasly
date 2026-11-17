/**
 * Neighbourhood providers (#773): free implementations parse City open data,
 * and switching an implementation is config-only (AC2).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import {
  createNeighbourhoodProviders,
  createSocrataRowsFetcher,
  isNeighbourhoodProviderName,
  type FetchLike,
} from '../src/services/neighbourhood-data/providers';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

const SCHOOL_ROWS = [
  {
    board: 'The Calgary School Division',
    name: 'Altadore School',
    address_ab: '4506 16 ST SW',
    postal_cod: 'T2T4H9',
    phone_no: '(403) 000-0000',
    email: 'school@example.org',
    grades: 'Elementary',
    elem: 'Y',
    junior_h: 'N',
    senior_h: 'N',
    postsecond: 'N',
    global_id: '{A1}',
    point: { type: 'Point', coordinates: [-114.098, 51.012] },
  },
  { name: 'No id school' },
];

/** Community Services rows (the fake ignores $where; the parser keeps every row). */
const AMENITY_ROWS = [
  {
    type: 'Library',
    name: 'Memorial Park Library',
    address: '2nd St SW',
    comm_code: 'BLN',
    point: { type: 'Point', coordinates: [-114.069, 51.041] },
  },
  // Exact duplicate — kept once.
  {
    type: 'Library',
    name: 'Memorial Park Library',
    address: '2nd St SW',
    comm_code: 'BLN',
    point: { type: 'Point', coordinates: [-114.069, 51.041] },
  },
  // No geometry — dropped.
  { type: 'Library', name: 'Nowhere Library' },
];

const COMMUNITY_ROWS = [
  {
    class: 'Residential',
    comm_code: 'ALT',
    name: 'ALTADORE',
    comm_structure: '1950s',
    latitude: '51.0137',
    longitude: '-114.0983',
  },
  // Newer community → excluded by the #690 rule.
  {
    class: 'Residential',
    comm_code: 'CRA',
    name: 'CRANSTON',
    comm_structure: 'BUILDING OUT',
    latitude: '50.88',
    longitude: '-113.96',
  },
  // Industrial → excluded.
  {
    class: 'Industrial',
    comm_code: 'FAI',
    name: 'FAIRVIEW INDUSTRIAL',
    comm_structure: 'INNER CITY',
    latitude: '50.98',
    longitude: '-114.05',
  },
];

const OVERPASS = { elements: [] };

function fakeFetch(byDataset: Record<string, unknown>): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const dataset = Object.keys(byDataset).find(
      (id) => url.includes(`/resource/${id}.json`) || (id === 'overpass' && url.includes('overpass')),
    );
    return {
      ok: dataset !== undefined,
      status: dataset ? 200 : 404,
      json: async () => (dataset ? byDataset[dataset] : {}),
    };
  };
  return { fetchImpl, urls };
}

/** ~1 km (lng) x ~1.11 km (lat) box around Altadore's centre. */
const ALT_BOUNDARY = {
  type: 'MultiPolygon',
  coordinates: [[[[-114.1055, 51.0087], [-114.0911, 51.0087], [-114.0911, 51.0187], [-114.1055, 51.0187], [-114.1055, 51.0087]]]],
};

const DATASETS = {
  'fd9t-tdn2': SCHOOL_ROWS,
  'x34e-bcjz': AMENITY_ROWS,
  'j9ps-fyst': COMMUNITY_ROWS,
  'kami-qbfh': [
    {
      asset_cd: 'P1',
      site_name: 'RIVER PARK',
      the_geom: {
        type: 'MultiPolygon',
        coordinates: [[[[-114.1, 51.01], [-114.098, 51.01], [-114.098, 51.012], [-114.1, 51.012], [-114.1, 51.01]]]],
      },
    },
    { asset_cd: 'P2', site_name: 'NO GEOMETRY' },
  ],
  'bdu9-amk8': [{ asset_cd: 'PG1', point: { type: 'Point', coordinates: [-114.097, 51.013] } }],
  'qndb-27qm': [
    {
      asset_cd: 'W1',
      the_geom: { type: 'MultiLineString', coordinates: [[[-114.11, 51.01], [-114.1, 51.02], [-114.09, 51.03]]] },
    },
  ],
  'hxfu-6d96': [
    { complex_name: 'Repsol Sport Centre', point: { type: 'Point', coordinates: [-114.062, 51.037] } },
  ],
  'enr4-crti': [
    {
      off_leash_area_id: 'ALT-001',
      description: 'ALTADORE',
      multipolygon: {
        type: 'MultiPolygon',
        coordinates: [[[[-114.1, 51.015], [-114.099, 51.015], [-114.099, 51.016], [-114.1, 51.016], [-114.1, 51.015]]]],
      },
    },
  ],
  'surr-xmvs': [
    { comm_code: 'ALT', name: 'ALTADORE', multipolygon: ALT_BOUNDARY },
    { comm_code: 'CRA', name: 'CRANSTON', multipolygon: ALT_BOUNDARY },
  ],
  'tfs4-3wwa': [{ comm_code: 'ALT', trees: '4000' }, { comm_code: 'CRA', trees: '10' }, { trees: '5' }],
  overpass: OVERPASS,
};

describe('neighbourhood providers — free implementations (#773)', () => {
  it('school directory: maps City Schools rows, drops rows without an id, keeps no contact details', async () => {
    // #774: the default 'free-public' directory also types each school and
    // finds its community.
    const { fetchImpl, urls } = fakeFetch(DATASETS);
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData, { fetchImpl });
    const rows = await providers.schoolDirectory.fetchAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: 'city-a1',
      name: 'Altadore School',
      board: 'Calgary Board of Education',
      grades: 'Elementary',
      schoolType: 'public_cbe',
      communityCode: 'ALT',
      lat: 51.012,
      lng: -114.098,
      data: { address: '4506 16 ST SW', elementary: true, juniorHigh: false },
    });
    expect(JSON.stringify(rows)).not.toMatch(/@|403\)/);
    expect(urls[0]).toBe('https://data.calgary.ca/resource/fd9t-tdn2.json?$limit=50000');
    expect(urls[1]).toBe('https://data.calgary.ca/resource/surr-xmvs.json?$limit=50000');
    expect(urls[2]).toMatch(/^https:\/\/overpass-api\.de\/api\/interpreter\?data=/);
  });

  it('amenities: every configured category plus per-community tree cover (#777)', async () => {
    const { fetchImpl, urls } = fakeFetch(DATASETS);
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData, { fetchImpl });
    const rows = await providers.amenities.fetchAll();

    const byCategory = (c: string) => rows.filter((r) => r.category === c);
    // Polygon park → interior point; name from site_name; id from asset_cd.
    expect(byCategory('parks')).toEqual([
      expect.objectContaining({ externalId: 'parks|p1', name: 'RIVER PARK', communityCode: null }),
    ]);
    const park = byCategory('parks')[0]!;
    expect(park.lat).toBeGreaterThan(51.01);
    expect(park.lat).toBeLessThan(51.012);
    // Line pathway → middle vertex.
    expect(byCategory('pathways')[0]).toMatchObject({ lat: 51.02, lng: -114.1 });
    // Playground without a name field → the category label.
    expect(byCategory('playgrounds')[0]).toMatchObject({ name: 'Playgrounds' });
    // Library from Community Services, de-duplicated, id from name + location.
    expect(byCategory('libraries')).toEqual([
      {
        externalId: 'libraries|memorial park library|51.04100,-114.06900',
        category: 'libraries',
        name: 'Memorial Park Library',
        communityCode: 'BLN',
        lat: 51.041,
        lng: -114.069,
        data: { address: '2nd St SW' },
      },
    ]);
    expect(byCategory('off-leash')[0]).toMatchObject({ externalId: 'off-leash|alt-001', name: 'ALTADORE' });
    expect(byCategory('rec-centres')).toHaveLength(1);
    expect(byCategory('pools')).toHaveLength(1);

    // Tree cover: established communities only (#690), trees / area.
    const cover = byCategory('tree-cover');
    expect(cover.map((r) => r.communityCode)).toEqual(['ALT']);
    expect(cover[0]).toMatchObject({ name: 'ALTADORE', lat: 51.0137, lng: -114.0983 });
    const data = cover[0]!.data as { slug: string; publicTrees: number; areaHa: number; treesPerHa: number };
    expect(data.slug).toBe('altadore');
    expect(data.publicTrees).toBe(4000);
    // ~1 km x ~1.11 km box ≈ 111 ha.
    expect(data.areaHa).toBeGreaterThan(100);
    expect(data.areaHa).toBeLessThan(125);
    expect(data.treesPerHa).toBeCloseTo(4000 / data.areaHa, 0);

    // SoQL filters and the grouped tree count come from config.
    expect(urls).toContain(
      `https://data.calgary.ca/resource/x34e-bcjz.json?$limit=50000&$where=${encodeURIComponent("type='Library'")}`,
    );
    expect(urls.some((u) => u.includes('/tfs4-3wwa.json') && u.includes('$group=comm_code'))).toBe(true);
  });

  it('amenities: categories are config-driven — add/remove one with env only (#777 AC3)', async () => {
    const env = {
      ...BASE_ENV,
      NEIGHBOURHOOD_AMENITY_CATEGORIES: JSON.stringify([
        { key: 'golf', label: 'Golf courses', datasetId: 'gggg-0000', nameField: 'name' },
      ]),
    } as NodeJS.ProcessEnv;
    const { fetchImpl, urls } = fakeFetch({
      ...DATASETS,
      'gggg-0000': [{ name: 'Shaganappi', point: { type: 'Point', coordinates: [-114.13, 51.04] } }],
    });
    const rows = await createNeighbourhoodProviders(loadConfig(env).neighbourhoodData, { fetchImpl })
      .amenities.fetchAll();
    expect([...new Set(rows.map((r) => r.category))]).toEqual(['golf', 'tree-cover']);
    expect(urls.some((u) => u.includes('kami-qbfh'))).toBe(false);
  });

  it('amenities: an empty category fails the refresh so old rows are kept', async () => {
    const { fetchImpl } = fakeFetch({ ...DATASETS, 'enr4-crti': [] });
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData, { fetchImpl });
    await expect(providers.amenities.fetchAll()).rejects.toThrow(/off-leash/);
  });

  it('rejects malformed amenity category config at startup', () => {
    const bad = (value: string) =>
      () => loadConfig({ ...BASE_ENV, NEIGHBOURHOOD_AMENITY_CATEGORIES: value } as NodeJS.ProcessEnv);
    expect(bad('not json')).toThrow(/NEIGHBOURHOOD_AMENITY_CATEGORIES/);
    expect(bad('[]')).toThrow(/NEIGHBOURHOOD_AMENITY_CATEGORIES/);
    expect(bad(JSON.stringify([{ key: 'Bad Key', label: 'x', datasetId: 'abcd-1234' }]))).toThrow(/kebab/);
    expect(bad(JSON.stringify([{ key: 'tree-cover', label: 'x', datasetId: 'abcd-1234' }]))).toThrow(/reserved/);
    expect(() =>
      loadConfig({ ...BASE_ENV, NEIGHBOURHOOD_TREE_COVER_THRESHOLDS: '20,10' } as NodeJS.ProcessEnv),
    ).toThrow(/NEIGHBOURHOOD_TREE_COVER_THRESHOLDS/);
  });

  it('commute: straight-line km from established residential communities only (#690)', async () => {
    const { fetchImpl } = fakeFetch(DATASETS);
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData, { fetchImpl });
    const rows = await providers.commute.fetchAll();
    expect(rows.map((r) => r.communityCode)).toEqual(['ALT']);
    const data = rows[0]!.data as { straightLineKm: number; destination: string };
    expect(data.destination).toBe('Downtown');
    // Altadore centre → City Hall is roughly 5 km in a straight line.
    expect(data.straightLineKm).toBeGreaterThan(4);
    expect(data.straightLineKm).toBeLessThan(6);
  });

  it('a Socrata error or non-array body throws (the job then keeps old data)', async () => {
    const failing = createSocrataRowsFetcher({
      socrataBaseUrl: 'https://data.example',
      httpTimeoutMs: 1_000,
      maxRows: 10,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => [] }),
    });
    await expect(failing('abcd-1234')).rejects.toThrow(/503/);
    const notArray = createSocrataRowsFetcher({
      socrataBaseUrl: 'https://data.example',
      httpTimeoutMs: 1_000,
      maxRows: 10,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: true }) }),
    });
    await expect(notArray('abcd-1234')).rejects.toThrow(/not an array/);
  });

  it('isNeighbourhoodProviderName accepts only the six provider keys', () => {
    expect(isNeighbourhoodProviderName('school-directory')).toBe(true);
    expect(isNeighbourhoodProviderName('commute')).toBe(true);
    expect(isNeighbourhoodProviderName('schools')).toBe(false);
    expect(isNeighbourhoodProviderName(undefined)).toBe(false);
  });
});

describe('neighbourhood providers — config-only switch (#773 AC2)', () => {
  it('defaults: free implementations for directory, amenities, commute, reviews (#776 maps-link); none for the rest', () => {
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData);
    expect(providers.schoolDirectory.implementation).toBe('free-public');
    expect(providers.amenities.implementation).toBe('calgary-open-data');
    expect(providers.commute.implementation).toBe('straight-line');
    expect(providers.schoolDesignation.implementation).toBe('none');
    expect(providers.schoolRatings.implementation).toBe('none');
    expect(providers.reviews.implementation).toBe('maps-link');
  });

  it('changing only env/config switches the implementation — and "none" makes no outside call', async () => {
    const env = {
      ...BASE_ENV,
      NEIGHBOURHOOD_SCHOOL_DIRECTORY_PROVIDER: 'none',
      NEIGHBOURHOOD_AMENITIES_PROVIDER: 'none',
      NEIGHBOURHOOD_COMMUTE_PROVIDER: 'none',
    } as NodeJS.ProcessEnv;
    const { fetchImpl, urls } = fakeFetch(DATASETS);
    const providers = createNeighbourhoodProviders(loadConfig(env).neighbourhoodData, { fetchImpl });
    expect(providers.schoolDirectory.implementation).toBe('none');
    expect(providers.amenities.implementation).toBe('none');
    expect(providers.commute.implementation).toBe('none');
    expect(await providers.schoolDirectory.fetchAll()).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it('dataset ids come from config, not code', async () => {
    const env = { ...BASE_ENV, NEIGHBOURHOOD_SCHOOLS_DATASET_ID: 'zzzz-0000' } as NodeJS.ProcessEnv;
    const { fetchImpl, urls } = fakeFetch({ ...DATASETS, 'zzzz-0000': SCHOOL_ROWS });
    const providers = createNeighbourhoodProviders(loadConfig(env).neighbourhoodData, { fetchImpl });
    expect(await providers.schoolDirectory.fetchAll()).toHaveLength(1);
    expect(urls[0]).toContain('/resource/zzzz-0000.json');
  });

  it('rejects an unknown implementation name at startup', () => {
    const env = { ...BASE_ENV, NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER: 'paid-vendor' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER/);
  });
});
