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
    board: 'Calgary Board of Education',
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

const AMENITY_ROWS = [
  {
    type: 'Community Centre',
    name: 'Rosemont Community Centre',
    address: '2807 10 ST NW',
    comm_code: 'CAP',
    point: { type: 'Point', coordinates: [-114.086, 51.0767] },
  },
  // Exact duplicate — kept once.
  {
    type: 'Community Centre',
    name: 'Rosemont Community Centre',
    address: '2807 10 ST NW',
    comm_code: 'CAP',
    point: { type: 'Point', coordinates: [-114.086, 51.0767] },
  },
  { type: '', name: 'Unnamed type' },
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

function fakeFetch(byDataset: Record<string, unknown>): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const dataset = Object.keys(byDataset).find((id) => url.includes(`/resource/${id}.json`));
    return {
      ok: dataset !== undefined,
      status: dataset ? 200 : 404,
      json: async () => (dataset ? byDataset[dataset] : {}),
    };
  };
  return { fetchImpl, urls };
}

const DATASETS = {
  'fd9t-tdn2': SCHOOL_ROWS,
  'x34e-bcjz': AMENITY_ROWS,
  'j9ps-fyst': COMMUNITY_ROWS,
};

describe('neighbourhood providers — free implementations (#773)', () => {
  it('school directory: maps City Schools rows, drops rows without an id, keeps no contact details', async () => {
    const { fetchImpl, urls } = fakeFetch(DATASETS);
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData, { fetchImpl });
    const rows = await providers.schoolDirectory.fetchAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '{A1}',
      name: 'Altadore School',
      board: 'Calgary Board of Education',
      grades: 'Elementary',
      lat: 51.012,
      lng: -114.098,
      data: { address: '4506 16 ST SW', elementary: true, juniorHigh: false },
    });
    expect(JSON.stringify(rows)).not.toMatch(/@|403\)/);
    expect(urls[0]).toBe('https://data.calgary.ca/resource/fd9t-tdn2.json?$limit=50000');
  });

  it('amenities: maps Community Services rows with a stable derived id and de-duplicates', async () => {
    const { fetchImpl } = fakeFetch(DATASETS);
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData, { fetchImpl });
    const rows = await providers.amenities.fetchAll();
    expect(rows).toEqual([
      {
        externalId: 'community centre|rosemont community centre|2807 10 st nw',
        category: 'Community Centre',
        name: 'Rosemont Community Centre',
        communityCode: 'CAP',
        lat: 51.0767,
        lng: -114.086,
        data: { address: '2807 10 ST NW' },
      },
    ]);
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
  it('defaults: free implementations for directory, amenities, commute; none for the rest', () => {
    const providers = createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData);
    expect(providers.schoolDirectory.implementation).toBe('calgary-open-data');
    expect(providers.amenities.implementation).toBe('calgary-open-data');
    expect(providers.commute.implementation).toBe('straight-line');
    expect(providers.schoolDesignation.implementation).toBe('none');
    expect(providers.schoolRatings.implementation).toBe('none');
    expect(providers.reviews.implementation).toBe('none');
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
    const { fetchImpl, urls } = fakeFetch({ 'zzzz-0000': SCHOOL_ROWS });
    const providers = createNeighbourhoodProviders(loadConfig(env).neighbourhoodData, { fetchImpl });
    expect(await providers.schoolDirectory.fetchAll()).toHaveLength(1);
    expect(urls[0]).toContain('/resource/zzzz-0000.json');
  });

  it('rejects an unknown implementation name at startup', () => {
    const env = { ...BASE_ENV, NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER: 'paid-vendor' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER/);
  });
});
