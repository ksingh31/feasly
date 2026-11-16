/**
 * Current land-use district (#686).
 *
 * Covers: the parcel interior-point helper (lib/geo), the Calgary Land Use
 * Districts provider (SoQL shape, DC bylaw, no hit, errors), the provider
 * factory, and the property-service integration ACs with Socrata mocked:
 *  AC1 roll "R-C2,R-CG" → current district "R-C2" (zoning too)
 *  AC2 district failure/timeout → roll value, source 'assessment-roll',
 *      one warning carrying the correlation id
 *  AC3 Direct Control parcel → 'DC' + dcBylaw
 *  AC4 a second lookup inside the TTL makes no Land Use Districts request
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parcelInteriorPoint, pointInRing } from '../src/lib/geo';
import {
  createCalgaryLandUseProvider,
  createLandUseProvider,
  type LandUseProvider,
} from '../src/services/land-use.service';
import { createPropertyService } from '../src/services/property.service';
import type { LandUseConfig, PropertyDataConfig } from '../src/config';

const PROPERTY_CONFIG: PropertyDataConfig = {
  socrataBaseUrl: 'https://data.calgary.ca',
  datasetId: '4bsw-nn7w',
  cacheTtlMs: 60_000,
  httpTimeoutMs: 5_000,
  searchRowLimit: 50,
  suggestionLimit: 8,
  redevelopmentMinAgeYears: 25,
};

const LAND_USE_CONFIG: LandUseConfig = {
  provider: 'calgary-land-use-districts',
  socrataBaseUrl: 'https://data.calgary.ca',
  datasetId: 'qe6k-p9nh',
  cacheTtlMs: 86_400_000,
  httpTimeoutMs: 3_000,
};

/** Real parcel polygon for 2032 42 AV SW (Socrata 4bsw-nn7w, 2026 roll). */
const PARCEL = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-114.1079884, 51.0164788],
        [-114.108097, 51.0164787],
        [-114.1082056, 51.0164787],
        [-114.1082063, 51.0161426],
        [-114.1080977, 51.0161426],
        [-114.1079891, 51.0161427],
        [-114.1079884, 51.0164788],
      ],
    ],
  ],
};

const ROLL_ROW = {
  roll_year: '2026',
  address: '2032 42 AV SW',
  assessed_value: '840500.0',
  assessment_class: 'RE',
  assessment_class_description: 'Residential',
  comm_name: 'ALTADORE',
  land_use_designation: 'R-C2,R-CG',
  land_size_sf: '6134.0',
  mod_date: '2026-01-14T00:00:00.000Z',
  multipolygon: PARCEL,
};

const R_C2 = {
  lu_code: 'R-C2',
  lu_bylaw: '1',
  description: 'Residential - Contextual One/Two Dwelling',
};

type Responder = (url: string, init?: RequestInit) => Promise<unknown>;

function json(body: unknown, ok = true, status = 200): Promise<unknown> {
  return Promise.resolve({ ok, status, json: async () => body });
}

/** Routes fetch by dataset: Land Use Districts vs the assessment roll. */
function stubSocrata(landUse: Responder, rows: unknown[] = [ROLL_ROW]) {
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/qe6k-p9nh.json')) return landUse(url, init);
    return json(rows);
  });
  vi.stubGlobal('fetch', fetchMock);
  const landUseCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/qe6k-p9nh.json')).length;
  return { fetchMock, landUseCalls };
}

function serviceWith(provider: LandUseProvider, logWarning = vi.fn()) {
  const service = createPropertyService(PROPERTY_CONFIG, {
    landUse: { provider, cacheTtlMs: LAND_USE_CONFIG.cacheTtlMs },
    logWarning,
  });
  return { service, logWarning };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('lib/geo parcelInteriorPoint', () => {
  it('returns the centroid of a rectangular lot (inside it)', () => {
    const p = parcelInteriorPoint(PARCEL);
    expect(p).not.toBeNull();
    expect(p!.lon).toBeCloseTo(-114.1081, 4);
    expect(p!.lat).toBeCloseTo(51.01631, 4);
    expect(pointInRing(p!, PARCEL.coordinates[0][0] as [number, number][])).toBe(true);
  });

  it('falls back to a scanline point when the centroid of a concave lot is outside', () => {
    // U-shape: the centroid sits in the notch, outside the polygon.
    const ring: [number, number][] = [
      [0, 0], [10, 0], [10, 10], [8, 10], [8, 2], [2, 2], [2, 10], [0, 10], [0, 0],
    ];
    const p = parcelInteriorPoint({ type: 'Polygon', coordinates: [ring] });
    expect(p).not.toBeNull();
    expect(pointInRing(p!, ring)).toBe(true);
  });

  it('uses the largest polygon of a multipolygon', () => {
    const small: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const big: [number, number][] = [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]];
    const p = parcelInteriorPoint({ type: 'MultiPolygon', coordinates: [[small], [big]] });
    expect(p).toEqual({ lon: 15, lat: 15 });
  });

  it('returns null for missing or malformed geometry', () => {
    expect(parcelInteriorPoint(undefined)).toBeNull();
    expect(parcelInteriorPoint({ type: 'Point', coordinates: [1, 2] })).toBeNull();
    expect(parcelInteriorPoint({ type: 'MultiPolygon', coordinates: [[[['x', 1]]]] })).toBeNull();
  });
});

describe('Calgary Land Use Districts provider', () => {
  it('queries intersects() at the point with a fixed $select/$limit', async () => {
    const { fetchMock } = stubSocrata(() => json([R_C2]));
    const provider = createCalgaryLandUseProvider(LAND_USE_CONFIG);
    const hit = await provider.resolve({ lon: -114.1081, lat: 51.01631 });
    expect(hit).toEqual({
      district: 'R-C2',
      description: 'Residential - Contextual One/Two Dwelling',
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://data.calgary.ca/resource/qe6k-p9nh.json');
    expect(url.searchParams.get('$where')).toBe(
      "intersects(multipolygon,'POINT(-114.1081 51.01631)')",
    );
    expect(url.searchParams.get('$select')).toBe('lu_code,description,dc_bylaw');
    expect(url.searchParams.get('$limit')).toBe('5');
  });

  it('returns DC with its bylaw number', async () => {
    stubSocrata(() => json([{ lu_code: 'DC', lu_bylaw: '2', dc_bylaw: '48Z84' }]));
    const hit = await createCalgaryLandUseProvider(LAND_USE_CONFIG).resolve({ lon: 1, lat: 2 });
    expect(hit).toEqual({ district: 'DC', description: '', dcBylaw: '48Z84' });
  });

  it('returns null when no polygon contains the point', async () => {
    stubSocrata(() => json([]));
    await expect(
      createCalgaryLandUseProvider(LAND_USE_CONFIG).resolve({ lon: 1, lat: 2 }),
    ).resolves.toBeNull();
  });

  it('is deterministic when a point sits on a shared edge', async () => {
    stubSocrata(() => json([{ lu_code: 'R-CG' }, { lu_code: 'R-C2' }]));
    const hit = await createCalgaryLandUseProvider(LAND_USE_CONFIG).resolve({ lon: 1, lat: 2 });
    expect(hit?.district).toBe('R-C2');
  });

  it('throws on a non-2xx response', async () => {
    stubSocrata(() => json({}, false, 503));
    await expect(
      createCalgaryLandUseProvider(LAND_USE_CONFIG).resolve({ lon: 1, lat: 2 }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('refuses a non-finite point instead of building SoQL from it', async () => {
    const { fetchMock } = stubSocrata(() => json([]));
    await expect(
      createCalgaryLandUseProvider(LAND_USE_CONFIG).resolve({ lon: NaN, lat: 2 }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('factory picks the provider from city config', () => {
    expect(createLandUseProvider(LAND_USE_CONFIG)).toBeDefined();
    expect(createLandUseProvider({ ...LAND_USE_CONFIG, provider: 'assessment-roll' })).toBeUndefined();
  });
});

describe('property lookup with the current land-use district', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('AC1: roll "R-C2,R-CG" resolves to the current district R-C2', async () => {
    stubSocrata(() => json([R_C2]));
    const { service } = serviceWith(createCalgaryLandUseProvider(LAND_USE_CONFIG));
    const res = await service.getProperty('2032 42 AV SW');
    expect(res.zoning).toBe('R-C2');
    expect(res.landUse).toEqual({
      district: 'R-C2',
      description: 'Residential - Contextual One/Two Dwelling',
      source: 'land-use-districts',
      asOf: new Date().toISOString().split('T')[0],
    });
  });

  it('AC2: a failed district request falls back to the roll value and warns once with the correlation id', async () => {
    stubSocrata(() => json({}, false, 500));
    const { service, logWarning } = serviceWith(createCalgaryLandUseProvider(LAND_USE_CONFIG));
    const res = await service.getProperty('2032 42 AV SW', { correlationId: 'corr-123' });
    expect(res.zoning).toBe('R-C2,R-CG');
    expect(res.landUse).toEqual({
      district: 'R-C2,R-CG',
      description: '',
      source: 'assessment-roll',
      asOf: '2026-01-14',
    });
    expect(logWarning).toHaveBeenCalledTimes(1);
    const message = String(logWarning.mock.calls[0][0]);
    expect(message).toContain('correlationId=corr-123');
    // No address or query string in the log line.
    expect(message).not.toContain('2032');
    expect(message).not.toContain('qe6k');
  });

  it('AC2: a timed-out district request falls back within the configured timeout', async () => {
    // Never answers until aborted by the provider's timeout.
    stubSocrata(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const provider = createCalgaryLandUseProvider({ ...LAND_USE_CONFIG, httpTimeoutMs: 20 });
    const { service, logWarning } = serviceWith(provider);
    const res = await service.getProperty('2032 42 AV SW', { correlationId: 'corr-t' });
    expect(res.landUse?.source).toBe('assessment-roll');
    expect(res.zoning).toBe('R-C2,R-CG');
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(String(logWarning.mock.calls[0][0])).toContain('AbortError');
  });

  it('falls back to the roll value when no district polygon is hit', async () => {
    stubSocrata(() => json([]));
    const { service, logWarning } = serviceWith(createCalgaryLandUseProvider(LAND_USE_CONFIG));
    const res = await service.getProperty('2032 42 AV SW');
    expect(res.landUse?.source).toBe('assessment-roll');
    expect(res.zoning).toBe('R-C2,R-CG');
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('falls back without a district request when the parcel has no polygon', async () => {
    const { landUseCalls } = stubSocrata(() => json([R_C2]), [
      { ...ROLL_ROW, multipolygon: undefined },
    ]);
    const { service } = serviceWith(createCalgaryLandUseProvider(LAND_USE_CONFIG));
    const res = await service.getProperty('2032 42 AV SW');
    expect(res.landUse?.source).toBe('assessment-roll');
    expect(landUseCalls()).toBe(0);
  });

  it('AC3: a Direct Control parcel returns DC with its bylaw number', async () => {
    stubSocrata(() => json([{ lu_code: 'DC', description: 'Direct Control', dc_bylaw: '48Z84' }]));
    const { service } = serviceWith(createCalgaryLandUseProvider(LAND_USE_CONFIG));
    const res = await service.getProperty('2032 42 AV SW');
    expect(res.zoning).toBe('DC');
    expect(res.landUse).toMatchObject({
      district: 'DC',
      dcBylaw: '48Z84',
      source: 'land-use-districts',
    });
  });

  it('AC4: a second lookup inside the TTL makes no district request, even after the roll cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    const { fetchMock, landUseCalls } = stubSocrata(() => json([R_C2]));
    const { service } = serviceWith(createCalgaryLandUseProvider(LAND_USE_CONFIG));

    await service.getProperty('2032 42 AV SW');
    expect(landUseCalls()).toBe(1);

    // Past the 60s roll cache, inside the 24h district TTL.
    vi.setSystemTime(new Date('2026-11-15T12:10:00Z'));
    const second = await service.getProperty('2032 42 AV SW');
    expect(fetchMock).toHaveBeenCalledTimes(3); // roll, district, roll again
    expect(landUseCalls()).toBe(1);
    expect(second.zoning).toBe('R-C2');
    expect(second.landUse?.asOf).toBe('2026-11-15');

    // Past the district TTL: re-checked.
    vi.setSystemTime(new Date('2026-11-16T12:10:01Z'));
    await service.getProperty('2032 42 AV SW');
    expect(landUseCalls()).toBe(2);
  });

  it('retries the district after a failure (failures are not cached)', async () => {
    let fail = true;
    const { landUseCalls } = stubSocrata(() => (fail ? json({}, false, 500) : json([R_C2])));
    const { service } = serviceWith(createCalgaryLandUseProvider(LAND_USE_CONFIG));
    const first = await service.getProperty('2032 42 AV SW');
    expect(first.landUse?.source).toBe('assessment-roll');
    fail = false;
    const second = await service.getProperty('2032 42 AV SW');
    expect(second.landUse?.source).toBe('land-use-districts');
    expect(landUseCalls()).toBe(2);
  });
});
