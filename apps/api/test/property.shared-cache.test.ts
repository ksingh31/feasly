/**
 * Shared City-data cache (#756).
 *
 * The Socrata layer is a global fetch stub; the durable tier is an
 * in-memory CityDataCacheStore fake (the Drizzle store has its own PGlite
 * test). Covers:
 *  - AC2: two simultaneous lookups for one uncached address → one City call
 *    (roll, district and autocomplete)
 *  - durable tier shared across instances: a second instance answers from
 *    the store with no City call
 *  - a failing or slow store never fails the lookup (falls through to the City)
 *  - telemetry: lookup source + city_call events, never an address
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPropertyService,
  type PropertyDataEvent,
  type PropertyServiceDeps,
} from '../src/services/property.service';
import type { CityDataCacheStore } from '../src/services/city-data-cache.store';
import type { LandUseProvider } from '../src/services/land-use.service';
import type { PropertyDataConfig } from '../src/config';

const CONFIG: PropertyDataConfig = {
  socrataBaseUrl: 'https://data.calgary.ca',
  datasetId: '4bsw-nn7w',
  cacheTtlMs: 60_000,
  httpTimeoutMs: 5_000,
  searchRowLimit: 50,
  suggestionLimit: 8,
  dbCacheTtlMs: 604_800_000,
  dbCacheTimeoutMs: 50,
  httpCacheMaxAgeSeconds: 3_600,
};

const KEY = '2032 42 AV SW';

const ROW = {
  roll_year: String(new Date().getFullYear()),
  address: KEY,
  assessed_value: '840500.0',
  assessment_class: 'RE',
  assessment_class_description: 'Residential',
  comm_name: 'ALTADORE',
  land_use_designation: 'R-C2,R-CG',
  land_size_sf: '6134.0',
  mod_date: '2026-01-15T00:00:00.000',
  multipolygon: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-114.1079884, 51.0164788],
          [-114.1082056, 51.0164787],
          [-114.1082063, 51.0161426],
          [-114.1079891, 51.0161427],
          [-114.1079884, 51.0164788],
        ],
      ],
    ],
  },
};

/** fetch stub whose responses resolve only when `release()` is called. */
function gatedFetch(body: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn(async () => {
    await gate;
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release };
}

function memoryStore(): CityDataCacheStore & { readonly entries: Map<string, unknown> } {
  const entries = new Map<string, { payload: unknown; expiresAt: Date }>();
  const view = new Map<string, unknown>();
  return {
    entries: view,
    async get(datasetId, key, now) {
      const hit = entries.get(`${datasetId}:${key}`);
      return hit && hit.expiresAt > now ? hit.payload : undefined;
    },
    async put(datasetId, key, payload, expiresAt) {
      entries.set(`${datasetId}:${key}`, { payload, expiresAt });
      view.set(`${datasetId}:${key}`, payload);
    },
  };
}

function landUse(provider: LandUseProvider): NonNullable<PropertyServiceDeps['landUse']> {
  return { provider, cacheTtlMs: 60_000, datasetId: 'qe6k-p9nh', dbCacheTtlMs: 604_800_000 };
}

describe('property service — shared City-data cache (#756)', () => {
  let events: PropertyDataEvent[];
  const onEvent = (event: PropertyDataEvent): void => {
    events.push(event);
  };

  beforeEach(() => {
    events = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('AC2: two simultaneous lookups for an uncached address make one City call', async () => {
    const { fetchMock, release } = gatedFetch([ROW]);
    const service = createPropertyService(CONFIG, { onEvent });
    const a = service.getProperty(KEY);
    const b = service.getProperty(KEY);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(rb);
    expect(ra.assessedValue).toBe(840_500);
    const sources = events.filter((e) => e.event === 'lookup').map((e) => e.source).sort();
    expect(sources).toEqual(['city', 'inflight']);
    expect(events.filter((e) => e.event === 'city_call')).toHaveLength(1);
  });

  it('AC2: concurrent district lookups for one parcel share one land-use call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [ROW] })));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolve = vi.fn(async () => {
      await gate;
      return { district: 'R-CG', description: 'Residential – Grade-Oriented Infill' };
    });
    const service = createPropertyService(CONFIG, { onEvent, landUse: landUse({ resolve }) });
    const a = service.getProperty(KEY);
    const b = service.getProperty(KEY);
    // Both requests must reach the district step before it resolves.
    const deadline = Date.now() + 2_000;
    while (resolve.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(ra.zoning).toBe('R-CG');
    expect(rb.zoning).toBe('R-CG');
  });

  it('AC2: concurrent identical autocomplete queries share one City call', async () => {
    const { fetchMock, release } = gatedFetch([ROW]);
    const service = createPropertyService(CONFIG, { onEvent });
    const a = service.autocomplete('2032 42 Ave SW');
    const b = service.autocomplete('2032 42 Ave SW');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(rb);
    expect(ra.suggestions).toHaveLength(1);
  });

  it('a second instance answers from the durable store with no City call', async () => {
    const store = memoryStore();
    const resolve = vi.fn(async () => ({ district: 'R-CG', description: 'Infill' }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [ROW] })));
    const first = createPropertyService(CONFIG, { cache: store, landUse: landUse({ resolve }) });
    const fromCity = await first.getProperty(KEY);
    expect(store.entries.has(`4bsw-nn7w:${KEY}`)).toBe(true);
    expect(store.entries.has(`qe6k-p9nh:${KEY}`)).toBe(true);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const second = createPropertyService(CONFIG, {
      cache: store,
      onEvent,
      landUse: landUse({ resolve }),
    });
    const fromStore = await second.getProperty(KEY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fromStore).toEqual(fromCity);
    expect(events).toEqual([
      { event: 'lookup', op: 'property', dataset: '4bsw-nn7w', source: 'db' },
      { event: 'lookup', op: 'district', dataset: 'qe6k-p9nh', source: 'db' },
    ]);

    // Third call on the same instance: in-memory tier.
    events = [];
    await second.getProperty(KEY);
    expect(events.map((e) => (e.event === 'lookup' ? e.source : e.event))).toEqual([
      'memory',
      'memory',
    ]);
  });

  it('ignores a malformed durable payload and refetches', async () => {
    const store = memoryStore();
    await store.put('4bsw-nn7w', KEY, { nonsense: true }, new Date(Date.now() + 60_000));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [ROW] }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createPropertyService(CONFIG, { cache: store });
    const record = await service.getProperty(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(record.addressKey).toBe(KEY);
  });

  it('a failing store never fails the lookup', async () => {
    const warnings: string[] = [];
    const broken: CityDataCacheStore = {
      get: vi.fn(async () => {
        throw new Error('connection refused to db.internal:5432');
      }),
      put: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [ROW] })));
    const service = createPropertyService(CONFIG, {
      cache: broken,
      logWarning: (m) => warnings.push(m),
    });
    const record = await service.getProperty(KEY);
    expect(record.addressKey).toBe(KEY);
    expect(warnings).toHaveLength(2);
    // Error class only — never the message.
    expect(warnings.join('\n')).not.toContain('db.internal');
  });

  it('a slow store read is cut off at dbCacheTimeoutMs and the City answers', async () => {
    const warnings: string[] = [];
    let releaseRead!: () => void;
    const slow: CityDataCacheStore = {
      get: () =>
        new Promise((resolve) => {
          releaseRead = () => resolve(undefined);
        }),
      put: vi.fn(async () => {}),
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [ROW] })));
    const service = createPropertyService(CONFIG, {
      cache: slow,
      logWarning: (m) => warnings.push(m),
    });
    const record = await service.getProperty(KEY);
    releaseRead();
    expect(record.addressKey).toBe(KEY);
    expect(warnings.some((w) => w.includes('cache read failed'))).toBe(true);
  });

  it('City errors emit an error city_call and are not cached', async () => {
    const store = memoryStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const service = createPropertyService(CONFIG, { cache: store, onEvent });
    await expect(service.getProperty(KEY)).rejects.toMatchObject({ status: 503 });
    expect(store.entries.size).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({ event: 'city_call', op: 'property', outcome: 'error' }),
    ]);
  });

  it('telemetry events never carry the address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [ROW] })));
    const service = createPropertyService(CONFIG, { onEvent });
    await service.getProperty(KEY);
    await service.autocomplete('2032 42 Ave SW');
    expect(JSON.stringify(events)).not.toContain('2032');
  });

  it('a throwing telemetry sink never fails the lookup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [ROW] })));
    const service = createPropertyService(CONFIG, {
      onEvent: () => {
        throw new Error('sink down');
      },
    });
    await expect(service.getProperty(KEY)).resolves.toMatchObject({ addressKey: KEY });
  });
});
