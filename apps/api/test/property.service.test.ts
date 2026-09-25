/**
 * Property service tests (api-mcp/02).
 *
 * The Socrata HTTP layer is mocked (global fetch stub); these tests cover:
 * query normalization (street-type abbreviations), autocomplete mapping +
 * dedupe + limit, property record mapping, deterministic best-row choice for
 * multi-parcel addresses, reno/05 miss mapping (OUT_OF_COVERAGE vs
 * ADDRESS_NOT_FOUND) + lookup.miss metric, DEPENDENCY_UNAVAILABLE
 * on transport failures, and the in-memory cache.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createPropertyService,
  type PropertyService,
} from '../src/services/property.service';
import type { PropertyDataConfig } from '../src/config';
import { ErrorCodes } from '../src/middleware/errors';

const CONFIG: PropertyDataConfig = {
  socrataBaseUrl: 'https://data.calgary.ca',
  datasetId: '4bsw-nn7w',
  cacheTtlMs: 60_000,
  httpTimeoutMs: 5_000,
  searchRowLimit: 50,
  suggestionLimit: 8,
};

const ROW = {
  roll_year: '2026',
  address: '1600 90 AV SW',
  assessed_value: '60150000',
  comm_name: 'BAYVIEW',
  year_of_construction: '1980',
  land_use_designation: 'C-C2',
  land_size_sf: '452960',
  mod_date: '2026-01-15T00:00:00.000',
};

function mockFetchOnce(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    }),
  );
}

describe('property service', () => {
  let service: PropertyService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = createPropertyService(CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('autocomplete', () => {
    it('returns suggestions for a natural-language query (AVE → AV)', async () => {
      mockFetchOnce([ROW]);
      const res = await service.autocomplete('1600 90 Ave SW');
      expect(res.suggestions).toHaveLength(1);
      expect(res.suggestions[0]).toEqual({
        addressKey: '1600 90 AV SW',
        address: '1600 90 Av SW, Calgary, AB',
        community: 'BAYVIEW',
      });
      // The SoQL query used the abbreviated street type.
      const fetchMock = vi.mocked(fetch);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('1600+90+AV+SW');
    });

    it('returns an empty list for short queries without hitting Socrata', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const res = await service.autocomplete('16');
      expect(res).toEqual({ suggestions: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('dedupes repeated addresses', async () => {
      mockFetchOnce([ROW, { ...ROW }]);
      const res = await service.autocomplete('1600 90 AV');
      expect(res.suggestions).toHaveLength(1);
    });

    it('respects the suggestion limit', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        ...ROW,
        address: `160${i} 90 AV SW`,
      }));
      mockFetchOnce(rows);
      const limited = createPropertyService({ ...CONFIG, suggestionLimit: 3 });
      const res = await limited.autocomplete('1600 90 AV');
      expect(res.suggestions).toHaveLength(3);
    });

    it('caches repeat queries (second call hits no HTTP)', async () => {
      mockFetchOnce([ROW]);
      await service.autocomplete('1600 90 AV');
      const fetchMock = vi.mocked(fetch);
      const calls = fetchMock.mock.calls.length;
      await service.autocomplete('1600 90 AV');
      expect(fetchMock.mock.calls.length).toBe(calls);
    });

    it('throws DEPENDENCY_UNAVAILABLE on transport failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );
      await expect(service.autocomplete('1600 90 AV')).rejects.toMatchObject({
        status: 503,
        code: ErrorCodes.DEPENDENCY_UNAVAILABLE,
      });
    });

    it('throws DEPENDENCY_UNAVAILABLE on non-OK Socrata responses', async () => {
      mockFetchOnce({ message: 'bad' }, false);
      await expect(service.autocomplete('1600 90 AV')).rejects.toMatchObject({
        status: 503,
        code: ErrorCodes.DEPENDENCY_UNAVAILABLE,
      });
    });
  });

  describe('getProperty', () => {
    it('maps a Socrata row to the PropertyRecord contract', async () => {
      mockFetchOnce([ROW]);
      const res = await service.getProperty('1600 90 AV SW');
      expect(res).toEqual({
        addressKey: '1600 90 AV SW',
        address: '1600 90 Av SW, Calgary, AB',
        community: 'BAYVIEW',
        lotSqft: 452960,
        zoning: 'C-C2',
        assessedValue: 60150000,
        assessmentYear: 2026,
        yearBuilt: 1980,
        dataAsOf: '2026-01-15',
        stale: false,
      });
    });

    it('picks the highest assessed value for multi-parcel addresses', async () => {
      mockFetchOnce([
        { ...ROW, assessed_value: '100000' },
        { ...ROW, assessed_value: '60150000' },
      ]);
      const res = await service.getProperty('1600 90 AV SW');
      expect(res.assessedValue).toBe(60150000);
    });

    it('throws ADDRESS_NOT_FOUND (reno/05) when the City has no record for a Calgary-looking address', async () => {
      mockFetchOnce([]);
      await expect(service.getProperty('999 NOWHERE ST NW')).rejects.toMatchObject({
        status: 404,
        code: ErrorCodes.ADDRESS_NOT_FOUND,
      });
    });

    it('throws ADDRESS_NOT_FOUND on a blank address key without hitting Socrata', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(service.getProperty('   ')).rejects.toMatchObject({
        status: 404,
        code: ErrorCodes.ADDRESS_NOT_FOUND,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws OUT_OF_COVERAGE for an explicit non-Calgary city token', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(service.getProperty('123 KING ST W TORONTO')).rejects.toMatchObject({
        status: 404,
        code: ErrorCodes.OUT_OF_COVERAGE,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws OUT_OF_COVERAGE for a non-Calgary postal code', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      // Socrata miss path: the query reaches the miss mapper with the
      // out-of-coverage signal.
      mockFetchOnce([]);
      await expect(service.getProperty('V6B 1A1')).rejects.toMatchObject({
        status: 404,
        code: ErrorCodes.OUT_OF_COVERAGE,
      });
    });

    it('emits lookup.miss with reason out_of_coverage', async () => {
      const misses: Array<{ reason: string; key: string }> = [];
      const svc = createPropertyService(CONFIG, {
        onLookupMiss: (reason, addressKey) => misses.push({ reason, key: addressKey }),
      });
      mockFetchOnce([]);
      await expect(svc.getProperty('V6B 1A1')).rejects.toMatchObject({
        code: ErrorCodes.OUT_OF_COVERAGE,
      });
      expect(misses).toEqual([{ reason: 'out_of_coverage', key: 'V6B 1A1' }]);
    });

    it('emits lookup.miss with reason not_found', async () => {
      const misses: Array<{ reason: string; key: string }> = [];
      const svc = createPropertyService(CONFIG, {
        onLookupMiss: (reason, addressKey) => misses.push({ reason, key: addressKey }),
      });
      mockFetchOnce([]);
      await expect(svc.getProperty('999 NOWHERE ST NW')).rejects.toMatchObject({
        code: ErrorCodes.ADDRESS_NOT_FOUND,
      });
      expect(misses).toEqual([{ reason: 'not_found', key: '999 NOWHERE ST NW' }]);
    });

    it('autocomplete throws OUT_OF_COVERAGE for an explicit non-Calgary query without hitting Socrata', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(service.autocomplete('123 King St W, Toronto')).rejects.toMatchObject({
        status: 404,
        code: ErrorCodes.OUT_OF_COVERAGE,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('caches property records', async () => {
      mockFetchOnce([ROW]);
      await service.getProperty('1600 90 AV SW');
      const fetchMock = vi.mocked(fetch);
      const calls = fetchMock.mock.calls.length;
      await service.getProperty('1600 90 AV SW');
      expect(fetchMock.mock.calls.length).toBe(calls);
    });
  });

  describe('HRD-005 — SoQL injection resistance', () => {
    it('escapes single quotes in the address field (injection-style input)', async () => {
      mockFetchOnce([]);
      // Classic injection attempt: the quote must be doubled, not break out
      // of the SoQL string literal.
      await expect(
        service.getProperty(`1600 90 AV SW' OR '1'='1`),
      ).rejects.toMatchObject({ code: ErrorCodes.ADDRESS_NOT_FOUND });
      const fetchMock = vi.mocked(fetch);
      const url = String(fetchMock.mock.calls[0][0]);
      // The escaped value appears with doubled quotes in the $where clause…
      // '1600 90 AV SW'' OR ''1''=''1' — quotes doubled, cannot break out.
      expect(url).toContain(`%27%271%27%27%3D%27%271`);
      // …and no unescaped quote breaks the string literal.
      expect(url).not.toMatch(/\$where=[^&]*'[^&]*'[^&]*'[^&]*'/);
    });

    it('never places user input in $select, $order, or $limit', async () => {
      mockFetchOnce([ROW]);
      await service.autocomplete(`1600 90 AV SW`);
      const fetchMock = vi.mocked(fetch);
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      const params = url.searchParams;
      // $select / $order / $limit are hardcoded — they must not contain
      // any fragment of the user query.
      expect(params.get('$select')).not.toContain('1600');
      expect(params.get('$order')).toBe('address');
      expect(params.get('$limit')).toBe(String(CONFIG.searchRowLimit));
      // Only $where carries the (escaped) user input.
      expect(params.get('$where')).toContain('1600 90 AV SW');
    });
  });
});
