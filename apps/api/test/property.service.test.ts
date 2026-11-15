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
  assessment_class: 'R',
  assessment_class_description: 'Residential',
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

    describe('full-address normalization (frontend PR #225 parity)', () => {
      const row2631 = { ...ROW, address: '2631 63 AV SW' };

      it('drops a trailing ", Calgary, AB" so full addresses return suggestions', async () => {
        mockFetchOnce([row2631]);
        const res = await service.autocomplete('2631 63 av sw, calgary, ab');
        expect(res.suggestions).toHaveLength(1);
        expect(res.suggestions[0]).toMatchObject({
          addressKey: '2631 63 AV SW',
          address: '2631 63 Av SW, Calgary, AB',
        });
        const url = String(vi.mocked(fetch).mock.calls[0][0]);
        // The SoQL predicate prefix-matches the street address, not the city tail.
        expect(url).toContain('2631+63+AV+SW');
        expect(url).not.toContain('CALGARY');
      });

      it('drops the suffix without commas ("2631 63 AV SW CALGARY AB")', async () => {
        mockFetchOnce([row2631]);
        const res = await service.autocomplete('2631 63 av sw calgary ab');
        expect(res.suggestions).toHaveLength(1);
        const url = String(vi.mocked(fetch).mock.calls[0][0]);
        expect(url).toContain('2631+63+AV+SW');
        expect(url).not.toContain('CALGARY');
      });

      it('drops a bare trailing ", Calgary"', async () => {
        mockFetchOnce([row2631]);
        const res = await service.autocomplete('2631 63 av sw, calgary');
        expect(res.suggestions).toHaveLength(1);
        const url = String(vi.mocked(fetch).mock.calls[0][0]);
        expect(url).toContain('2631+63+AV+SW');
        expect(url).not.toContain('CALGARY');
      });

      it('leaves a mid-query Calgary token alone', async () => {
        mockFetchOnce([{ ...ROW, address: '100 CALGARY TR NW' }]);
        await service.autocomplete('100 calgary trail nw');
        const url = String(vi.mocked(fetch).mock.calls[0][0]);
        // Anchored at the end: a street name containing the token is untouched.
        expect(url).toContain('100+CALGARY+TR+NW');
      });

      it('partial address still prefix-matches', async () => {
        mockFetchOnce([row2631]);
        const res = await service.autocomplete('2631 63');
        expect(res.suggestions).toHaveLength(1);
        const url = String(vi.mocked(fetch).mock.calls[0][0]);
        expect(url).toContain('2631+63');
      });

      it('a bare ", Calgary, AB" query resolves to an empty list without hitting Socrata', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const res = await service.autocomplete('Calgary, AB');
        expect(res).toEqual({ suggestions: [] });
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });

    describe('#701 — common inputs, fallback search, miss reasons', () => {
      const prospect = { ...ROW, address: '1412 PROSPECT AV SW', comm_name: 'MOUNT ROYAL UPPER' };
      const unitRow = { ...ROW, address: '201 1234 17 AV SW' };

      /** fetch stub answering each call from the list in order. */
      function mockFetchSequence(...bodies: unknown[]): ReturnType<typeof vi.fn> {
        const fn = vi.fn();
        for (const body of bodies) fn.mockResolvedValueOnce({ ok: true, json: async () => body });
        vi.stubGlobal('fetch', fn);
        return fn;
      }

      function whereOf(fn: ReturnType<typeof vi.fn>, call: number): string {
        return new URL(String(fn.mock.calls[call][0])).searchParams.get('$where') ?? '';
      }

      it.each(['1412 Prospect Av Southwest', '1412 Prospect Av S.W.', '1412 Prospect Avenue SW'])(
        '"%s" prefix-matches 1412 PROSPECT AV SW with one City request',
        async (input) => {
          const fn = mockFetchSequence([prospect]);
          const res = await service.autocomplete(input);
          expect(res.suggestions.map((s) => s.addressKey)).toEqual(['1412 PROSPECT AV SW']);
          expect(fn).toHaveBeenCalledTimes(1);
          expect(whereOf(fn, 0)).toBe("starts_with(upper(address),'1412 PROSPECT AV SW')");
        },
      );

      it.each(['#201 1234 17 Ave SW', '201-1234 17 Ave SW'])(
        '"%s" (unit first) searches the City unit format',
        async (input) => {
          const fn = mockFetchSequence([unitRow]);
          const res = await service.autocomplete(input);
          expect(res.suggestions.map((s) => s.addressKey)).toEqual(['201 1234 17 AV SW']);
          expect(whereOf(fn, 0)).toBe("starts_with(upper(address),'201 1234 17 AV SW')");
        },
      );

      it('falls back to house number + street name when the prefix search is empty', async () => {
        const fn = mockFetchSequence([], [unitRow, { ...ROW, address: '1234 17 AV SW' }]);
        const res = await service.autocomplete('Unit 999 1234 17th Avenue SW');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(whereOf(fn, 1)).toBe(
          "starts_with(upper(address),'1234 17 ') OR upper(address) like '% 1234 17 %'",
        );
        expect(res.suggestions.map((s) => s.addressKey)).toEqual([
          '201 1234 17 AV SW',
          '1234 17 AV SW',
        ]);
        // Fallback rows are capped like the primary search.
        expect(new URL(String(fn.mock.calls[1][0])).searchParams.get('$limit')).toBe('50');
      });

      it('finds the address despite a wrong street type via the fallback', async () => {
        const fn = mockFetchSequence([], [prospect]);
        const res = await service.autocomplete('1412 Prospect St SW');
        expect(res.suggestions.map((s) => s.addressKey)).toEqual(['1412 PROSPECT AV SW']);
        expect(fn).toHaveBeenCalledTimes(2);
      });

      it('never makes more than two City requests, and caches the empty answer', async () => {
        const fn = mockFetchSequence([], []);
        await service.autocomplete('1412 Nowhere Av SW');
        await service.autocomplete('1412 Nowhere Av SW');
        expect(fn).toHaveBeenCalledTimes(2);
      });

      it('runs no fallback without a house number', async () => {
        const fn = mockFetchSequence([]);
        const res = await service.autocomplete('prospect av');
        expect(res.suggestions).toEqual([]);
        expect(fn).toHaveBeenCalledTimes(1);
      });

      it('answers a Calgary postal code with no City request and the postal_code reason (FSA only)', async () => {
        const fn = vi.fn();
        vi.stubGlobal('fetch', fn);
        const misses: Array<{ reason: string; key: string }> = [];
        const svc = createPropertyService(CONFIG, {
          onLookupMiss: (reason, key) => misses.push({ reason, key }),
        });
        expect(await svc.autocomplete('T2T 0X5')).toEqual({ suggestions: [] });
        expect(await svc.autocomplete('T2T 0X5')).toEqual({ suggestions: [] });
        expect(fn).not.toHaveBeenCalled();
        expect(misses).toEqual([{ reason: 'postal_code', key: 'T2T' }]);
      });

      it.each([
        ['prospect av', 'no_house_number', 'PROSPECT AV'],
        ['#999 1234 17 Ave SW', 'unit', '999 1234 17 AV SW'],
        ['1412 Nowhere Av SW', 'not_found', '1412 NOWHERE AV SW'],
      ])('"%s" miss emits reason %s with the normalized key only', async (input, reason, key) => {
        mockFetchSequence([], []);
        const misses: Array<{ reason: string; key: string }> = [];
        const svc = createPropertyService(CONFIG, {
          onLookupMiss: (r, k) => misses.push({ reason: r, key: k }),
        });
        await svc.autocomplete(input);
        expect(misses).toEqual([{ reason, key }]);
        expect(misses[0].key).not.toBe(input);
      });

      it('emits no miss when suggestions are found', async () => {
        mockFetchSequence([prospect]);
        const misses: string[] = [];
        const svc = createPropertyService(CONFIG, { onLookupMiss: (r) => misses.push(r) });
        await svc.autocomplete('1412 Prospect Av SW');
        expect(misses).toEqual([]);
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
        assessmentYearInferred: false,
        yearBuilt: 1980,
        assessmentClass: 'R',
        isNonResidential: false,
        dataAsOf: '2026-01-15',
        stale: false,
        // #686: no land-use provider wired → the roll value, flagged as such.
        landUse: {
          district: 'C-C2',
          description: '',
          source: 'assessment-roll',
          asOf: '2026-01-15',
        },
      });
    });

    // #622: never present a guessed roll year as one read from the City.
    it('flags the assessment year as inferred when the row has no roll_year', async () => {
      mockFetchOnce([{ ...ROW, roll_year: undefined }]);
      const res = await service.getProperty('1600 90 AV SW');
      expect(res.assessmentYearInferred).toBe(true);
      expect(res.assessmentYear).toBe(new Date().getFullYear());
    });

    it('flags a non-residential (NR) row as isNonResidential', async () => {
      mockFetchOnce([
        {
          ...ROW,
          address: '12345 40 ST SE',
          assessed_value: '61580000',
          assessment_class: 'NR',
          assessment_class_description: 'Non-Residential',
          comm_name: 'EAST SHEPARD INDUSTRIAL',
        },
      ]);
      const res = await service.getProperty('12345 40 ST SE');
      expect(res.assessmentClass).toBe('NR');
      expect(res.isNonResidential).toBe(true);
    });

    it('treats a non-residential description as NR even without the class code', async () => {
      mockFetchOnce([
        {
          ...ROW,
          assessment_class: undefined,
          assessment_class_description: 'Non-Residential',
        },
      ]);
      const res = await service.getProperty('1600 90 AV SW');
      expect(res.assessmentClass).toBe('');
      expect(res.isNonResidential).toBe(true);
    });

    it('requests the assessment-class columns in the detail $select', async () => {
      mockFetchOnce([ROW]);
      await service.getProperty('1600 90 AV SW');
      const fetchMock = vi.mocked(fetch);
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      const select = url.searchParams.get('$select') ?? '';
      expect(select).toContain('assessment_class');
      expect(select).toContain('assessment_class_description');
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
