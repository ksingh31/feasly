/**
 * #737 AC4: City open-data API degradation.
 *
 * With the City Socrata API stubbed to fail or to hang, the property
 * endpoints must:
 * - answer the documented error state (503 DEPENDENCY_UNAVAILABLE,
 *   retryable) within the configured HTTP timeout, never hang the funnel;
 * - recover on the next request once the City answers again, on the SAME
 *   service instance (no restart, no cached failure);
 * - keep serving already-cached records during the outage.
 *
 * No fixed sleeps: the "slow" stub only settles when the service aborts it,
 * so the assertions wait on the real timeout path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPropertyService } from '../src/services/property.service';
import type { PropertyDataConfig } from '../src/config';
import { ErrorCodes } from '../src/middleware/errors';

const TIMEOUT_MS = 50;

const CONFIG: PropertyDataConfig = {
  socrataBaseUrl: 'https://data.calgary.ca',
  datasetId: '4bsw-nn7w',
  cacheTtlMs: 60_000,
  httpTimeoutMs: TIMEOUT_MS,
  searchRowLimit: 50,
  suggestionLimit: 8,
  dbCacheTtlMs: 604_800_000,
  dbCacheTimeoutMs: 1_500,
  httpCacheMaxAgeSeconds: 3_600,
  historyDatasetId: '4ur7-wsgc',
  historyDbCacheTtlMs: 604_800_000,
  historyRowLimit: 500,
};

const ROW = {
  roll_year: '2026',
  address: '1600 90 AV SW',
  assessed_value: '60150000',
  assessment_class: 'R',
  assessment_class_description: 'Residential',
  comm_name: 'BAYVIEW',
  year_of_construction: '1980',
  land_use_designation: 'R-CG',
  land_size_sf: '6000',
  mod_date: '2026-01-15T00:00:00.000',
};

type CityMode = 'ok' | 'down' | 'hang' | 'http-500';

/**
 * A switchable City stub. `hang` never answers on its own: it rejects only
 * when the caller's AbortSignal fires, like a real stalled socket.
 */
function stubCity(): { set(mode: CityMode): void; calls(): number } {
  let mode: CityMode = 'ok';
  const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
    switch (mode) {
      case 'ok':
        return Promise.resolve({ ok: true, json: async () => [ROW] });
      case 'http-500':
        return Promise.resolve({ ok: false, json: async () => ({}) });
      case 'down':
        return Promise.reject(new TypeError('fetch failed'));
      case 'hang':
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    set: (next) => {
      mode = next;
    },
    calls: () => fetchMock.mock.calls.length,
  };
}

const UNAVAILABLE = {
  status: 503,
  code: ErrorCodes.DEPENDENCY_UNAVAILABLE,
};

describe('property service under City API degradation (#737 AC4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a hanging City API yields 503 DEPENDENCY_UNAVAILABLE at the configured timeout (lookup)', async () => {
    const city = stubCity();
    city.set('hang');
    const service = createPropertyService(CONFIG);
    const started = Date.now();
    await expect(service.getProperty('1600 90 AV SW')).rejects.toMatchObject(UNAVAILABLE);
    const elapsed = Date.now() - started;
    // Bounded by the timeout (plus scheduling slack), not left hanging.
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 2_000);
  });

  it('a hanging City API yields 503 at the timeout (autocomplete)', async () => {
    const city = stubCity();
    city.set('hang');
    const service = createPropertyService(CONFIG);
    await expect(service.autocomplete('1600 90 AV')).rejects.toMatchObject(UNAVAILABLE);
  });

  it.each<CityMode>(['down', 'http-500', 'hang'])(
    'recovers without a restart after the City API was %s',
    async (failure) => {
      const city = stubCity();
      const service = createPropertyService(CONFIG);

      city.set(failure);
      await expect(service.getProperty('1600 90 AV SW')).rejects.toMatchObject(UNAVAILABLE);
      await expect(service.autocomplete('1600 90 AV')).rejects.toMatchObject(UNAVAILABLE);

      // City back up: the same instance answers on the very next request,
      // so failures were not cached.
      city.set('ok');
      const record = await service.getProperty('1600 90 AV SW');
      expect(record.address).toContain('1600 90');
      const suggestions = await service.autocomplete('1600 90 AV');
      expect(suggestions.suggestions).toHaveLength(1);
    },
  );

  it('keeps serving cached records while the City API is down', async () => {
    const city = stubCity();
    const service = createPropertyService(CONFIG);

    await service.getProperty('1600 90 AV SW');
    const callsAfterWarm = city.calls();

    city.set('down');
    const record = await service.getProperty('1600 90 AV SW');
    expect(record.address).toContain('1600 90');
    expect(city.calls()).toBe(callsAfterWarm);
  });
});
