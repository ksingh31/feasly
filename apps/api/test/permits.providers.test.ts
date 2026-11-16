/**
 * PermitsProvider (#822): City Building + Development Permits → `permits`
 * records for established communities only, no applicant names, builder only
 * when the City lists a company, truncated snapshots refused.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import {
  companyName,
  createCalgaryPermitsProvider,
  createNeighbourhoodProviders,
  createSocrataRowsFetcher,
  TruncatedPermitsError,
  type FetchLike,
} from '../src/services/neighbourhood-data/providers';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

const COMMUNITY_ROWS = [
  { class: 'Residential', comm_code: 'ALT', name: 'ALTADORE', comm_structure: '1950s' },
  { class: 'Residential', comm_code: 'CRA', name: 'CRANSTON', comm_structure: 'BUILDING OUT' },
];

const BP_ROWS = [
  {
    permitnum: 'BP2025-00001',
    statuscurrent: 'Issued Permit',
    applieddate: '2025-03-01T00:00:00.000',
    issueddate: '2025-06-01T00:00:00.000',
    permitclassgroup: 'Two Family',
    applicantname: 'JANE PRIVATE',
    contractorname: 'ACME  HOMES LTD',
    housingunits: '2',
    originaladdress: '4504 16 ST SW',
    communitycode: 'ALT',
    point: { type: 'Point', coordinates: [-114.0983, 51.0146] },
  },
  // Contractor reads as a person → no builder.
  {
    permitnum: 'BP2025-00002',
    statuscurrent: 'In Review',
    applieddate: '2025-09-01T00:00:00.000',
    permitclassgroup: 'Single Family',
    contractorname: 'JOHN SMITH',
    originaladdress: '4510 16 ST SW',
    communitycode: 'ALT',
    latitude: '51.0155',
    longitude: '-114.0983',
  },
  // Not an established community → dropped.
  {
    permitnum: 'BP2025-00003',
    communitycode: 'CRA',
    point: { type: 'Point', coordinates: [-113.96, 50.88] },
  },
  // No location → dropped.
  { permitnum: 'BP2025-00004', communitycode: 'ALT' },
];

const DP_ROWS = [
  {
    permitnum: 'DP2024-00010',
    address: '4504 16 ST SW',
    applicant: 'JANE PRIVATE',
    category: 'Residential - New Single / Semi / Duplex',
    statuscurrent: 'Released',
    applieddate: '2024-09-01T00:00:00.000',
    decisiondate: '2024-12-01T00:00:00.000',
    communitycode: 'ALT',
    point: { type: 'Point', coordinates: [-114.0983, 51.0146] },
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

const DATASETS = { 'j9ps-fyst': COMMUNITY_ROWS, 'c2es-76ed': BP_ROWS, '6933-unw5': DP_ROWS };

function provider(fetchImpl: FetchLike, maxRows = 50_000) {
  const config = loadConfig(BASE_ENV).neighbourhoodData;
  return createCalgaryPermitsProvider({
    fetchRows: createSocrataRowsFetcher({
      socrataBaseUrl: config.socrataBaseUrl,
      httpTimeoutMs: 1_000,
      maxRows,
      fetchImpl,
    }),
    permits: config.permits,
    communityPointsDatasetId: config.communityPointsDatasetId,
    communityClass: config.communityClass,
    communityStructures: config.communityStructures,
    maxRows,
    clock: () => new Date('2026-11-16T07:00:00Z'),
  });
}

describe('PermitsProvider — calgary-open-data (#822)', () => {
  it('maps BPs and DPs of established communities; never keeps an applicant; builder only for companies', async () => {
    const { fetchImpl } = fakeFetch(DATASETS);
    const rows = await provider(fetchImpl).fetchAll();
    expect(rows.map((r) => r.externalId)).toEqual([
      'building|bp2025-00001',
      'building|bp2025-00002',
      'development|dp2024-00010',
    ]);
    expect(rows[0]).toEqual({
      externalId: 'building|bp2025-00001',
      kind: 'building',
      permitNumber: 'BP2025-00001',
      communityCode: 'ALT',
      lat: 51.0146,
      lng: -114.0983,
      status: 'Issued Permit',
      appliedOn: '2025-03-01',
      decidedOn: '2025-06-01',
      address: '4504 16 ST SW',
      permitType: 'Two Family',
      housingUnits: 2,
      builder: 'ACME HOMES LTD',
      data: { communityName: 'ALTADORE', slug: 'altadore' },
    });
    expect(rows[1]).toMatchObject({ builder: null, decidedOn: null, housingUnits: null, lat: 51.0155 });
    expect(rows[2]).toMatchObject({
      kind: 'development',
      permitType: 'Residential - New Single / Semi / Duplex',
      decidedOn: '2024-12-01',
      builder: null,
    });
    expect(JSON.stringify(rows)).not.toMatch(/JANE|JOHN|SMITH/);
  });

  it('queries only the configured classes / categories, the history window and established community codes', async () => {
    const { fetchImpl, urls } = fakeFetch(DATASETS);
    await provider(fetchImpl).fetchAll();
    const bp = decodeURIComponent(urls.find((u) => u.includes('c2es-76ed'))!);
    expect(bp).toContain(
      "permitclassgroup in('Single Family','Two Family','Townhouse','Additional Dwelling') AND workclassgroup='New'",
    );
    expect(bp).toContain("applieddate >= '2021-01-01'");
    expect(bp).toContain("communitycode in('ALT')");
    expect(bp).not.toContain('applicantname');
    const dp = decodeURIComponent(urls.find((u) => u.includes('6933-unw5'))!);
    expect(dp).toContain("category in('Residential - New Single / Semi / Duplex',");
    expect(dp).toContain("communitycode in('ALT')");
    expect(dp).not.toMatch(/\bapplicant\b/);
  });

  it('refuses a snapshot that hit the row cap (old rows kept)', async () => {
    const { fetchImpl } = fakeFetch(DATASETS);
    await expect(provider(fetchImpl, 3).fetchAll()).rejects.toBeInstanceOf(TruncatedPermitsError);
  });

  it('fails when the community list is empty (no prune to nothing)', async () => {
    const { fetchImpl } = fakeFetch({ ...DATASETS, 'j9ps-fyst': [] });
    await expect(provider(fetchImpl).fetchAll()).rejects.toThrow(/established/);
  });

  it('companyName keeps company-like names only', () => {
    const markers = loadConfig(BASE_ENV).neighbourhoodData.permits.companyMarkers;
    expect(companyName('Elite Craft Builders', markers)).toBe('Elite Craft Builders');
    expect(companyName('1234567 ALBERTA LTD.', markers)).toBe('1234567 ALBERTA LTD.');
    expect(companyName('JOHN SMITH', markers)).toBeNull();
    expect(companyName('HOMER SIMPSON', markers)).toBeNull();
    expect(companyName('', markers)).toBeNull();
    expect(companyName(undefined, markers)).toBeNull();
  });

  it('is the default implementation; "none" is config-only and calls nothing', async () => {
    expect(createNeighbourhoodProviders(loadConfig(BASE_ENV).neighbourhoodData).permits.implementation).toBe(
      'calgary-open-data',
    );
    const { fetchImpl, urls } = fakeFetch(DATASETS);
    const off = createNeighbourhoodProviders(
      loadConfig({ ...BASE_ENV, NEIGHBOURHOOD_PERMITS_PROVIDER: 'none' } as NodeJS.ProcessEnv).neighbourhoodData,
      { fetchImpl },
    );
    expect(off.permits.implementation).toBe('none');
    expect(await off.permits.fetchAll()).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it('rejects a record URL template without {permitNumber}', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, NEIGHBOURHOOD_PERMITS_RECORD_URL_TEMPLATE: 'https://example.org/' } as NodeJS.ProcessEnv),
    ).toThrow(/NEIGHBOURHOOD_PERMITS_RECORD_URL_TEMPLATE/);
  });
});
