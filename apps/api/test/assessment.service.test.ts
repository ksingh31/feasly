/**
 * Assessment detail + history service tests (#695).
 *
 * The real property service runs against a global fetch stub that routes by
 * dataset (current-year `4bsw-nn7w` vs history `4ur7-wsgc`), so these cover
 * the whole read path: comma-string parsing, duplicate and missing roll
 * years, an address with no history, the leading-zero roll-number mismatch,
 * degrade-never-fail on a history outage, the lookup error contract, and
 * conformance of the response with the published OpenAPI schema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import {
  createPropertyService,
  normalizeRollNumber,
  parseCityAmount,
  type AssessmentHistoryRow,
} from '../src/services/property.service';
import {
  buildAssessmentHistory,
  createAssessmentService,
  type AssessmentService,
} from '../src/services/assessment.service';
import type { CityDataCacheStore } from '../src/services/city-data-cache.store';
import type { PropertyDataConfig } from '../src/config';
import { ErrorCodes } from '../src/middleware/errors';
import { PropertyAssessmentResponseSchema } from '../src/openapi/schemas';

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

const KEY = '1412 PROSPECT AV SW';

/** Current-year row, shaped like the live City response (2026-11-16). */
const CURRENT = {
  roll_year: '2026',
  roll_number: '080196603',
  address: KEY,
  assessed_value: '2770000.0',
  assessment_class: 'RE',
  assessment_class_description: 'Residential',
  property_type: 'LI',
  sub_property_use: 'R110',
  comm_name: 'UPPER MOUNT ROYAL',
  year_of_construction: '1912',
  land_use_designation: 'R-CG',
  land_size_sf: '15000',
  mod_date: '2026-01-14T00:00:00.000Z',
};

/** History rows: comma strings, no leading zero on the roll number. */
function historyRow(year: number | string, value: string, rollNumber = '80196603') {
  return { roll_year: String(year), roll_number: rollNumber, address: KEY, assessed_value: value };
}

const HISTORY = [
  historyRow(2025, '2,630,000'),
  historyRow(2024, '2,170,000'),
  historyRow(2023, '1,970,000'),
  historyRow(2022, '1,950,000'),
  historyRow(2021, '1,790,000'),
  historyRow(2014, '1700000'),
];

type Mode = 'ok' | 'http-500' | 'down' | 'hang';

interface CityStub {
  current: { mode: Mode; body: unknown };
  history: { mode: Mode; body: unknown };
  calls(dataset: string): number;
}

/** Routes fetch by dataset id; `hang` rejects only when the caller aborts. */
function stubCity(currentBody: unknown = [CURRENT], historyBody: unknown = HISTORY): CityStub {
  const stub: CityStub = {
    current: { mode: 'ok', body: currentBody },
    history: { mode: 'ok', body: historyBody },
    calls: (dataset) =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes(`/${dataset}.json`)).length,
  };
  const fetchMock = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
    const target = String(url).includes(`/${CONFIG.historyDatasetId}.json`)
      ? stub.history
      : stub.current;
    switch (target.mode) {
      case 'ok':
        return Promise.resolve({ ok: true, json: async () => target.body });
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
  return stub;
}

function memoryStore(): CityDataCacheStore & { readonly keys: string[] } {
  const entries = new Map<string, unknown>();
  const keys: string[] = [];
  return {
    keys,
    async get(datasetId, key) {
      return entries.get(`${datasetId}:${key}`);
    },
    async put(datasetId, key, payload) {
      entries.set(`${datasetId}:${key}`, payload);
      keys.push(`${datasetId}:${key}`);
    },
  };
}

function makeService(
  warnings: string[] = [],
  cache?: CityDataCacheStore,
): AssessmentService {
  const properties = createPropertyService(CONFIG, {
    logWarning: () => {},
    ...(cache ? { cache } : {}),
  });
  return createAssessmentService({ properties, logWarning: (m) => warnings.push(m) });
}

const RECORD: PropertyRecord = {
  addressKey: KEY,
  address: '1412 Prospect Av SW, Calgary, AB',
  community: 'UPPER MOUNT ROYAL',
  lotSqft: 15000,
  zoning: 'R-CG',
  assessedValue: 2_770_000,
  assessmentYear: 2026,
  assessmentYearInferred: false,
  yearBuilt: 1912,
  assessmentClass: 'RE',
  isNonResidential: false,
  dataAsOf: '2026-01-14',
  stale: false,
};

function rows(...entries: Array<[number, number, string | null]>): AssessmentHistoryRow[] {
  return entries.map(([rollYear, assessedValue, rollNumber]) => ({
    rollYear,
    assessedValue,
    rollNumber,
  }));
}

describe('City value parsing (#695)', () => {
  it('parses comma-formatted and decimal amounts', () => {
    expect(parseCityAmount('2,630,000')).toBe(2_630_000);
    expect(parseCityAmount('2770000.0')).toBe(2_770_000);
    expect(parseCityAmount('1700000')).toBe(1_700_000);
    expect(parseCityAmount(918000)).toBe(918_000);
  });

  it('rejects missing or malformed amounts', () => {
    expect(parseCityAmount(undefined)).toBeNull();
    expect(parseCityAmount('')).toBeNull();
    expect(parseCityAmount('n/a')).toBeNull();
  });

  it('compares roll numbers without leading zeros', () => {
    expect(normalizeRollNumber('080196603')).toBe('80196603');
    expect(normalizeRollNumber('80196603')).toBe('80196603');
    expect(normalizeRollNumber(80196603)).toBe('80196603');
    expect(normalizeRollNumber('  ')).toBeNull();
    expect(normalizeRollNumber(undefined)).toBeNull();
  });
});

describe('buildAssessmentHistory (#695)', () => {
  it('de-duplicates roll years — highest value wins', () => {
    const history = buildAssessmentHistory(
      rows([2024, 500_000, null], [2024, 650_000, null], [2023, 480_000, null]),
      { ...RECORD, assessmentYear: 2026 },
      null,
    );
    expect(history).toEqual([
      { rollYear: 2026, assessedValue: 2_770_000 },
      { rollYear: 2024, assessedValue: 650_000 },
      { rollYear: 2023, assessedValue: 480_000 },
    ]);
  });

  it('keeps missing years as gaps (never invents values), newest first', () => {
    const history = buildAssessmentHistory(
      rows([2010, 300_000, null], [2025, 900_000, null], [2015, 400_000, null]),
      RECORD,
      null,
    );
    expect(history.map((p) => p.rollYear)).toEqual([2026, 2025, 2015, 2010]);
  });

  it('merges the current roll year from the current-year record (authoritative)', () => {
    const history = buildAssessmentHistory(rows([2026, 1, null], [2025, 2, null]), RECORD, null);
    expect(history[0]).toEqual({ rollYear: 2026, assessedValue: 2_770_000 });
  });

  it('does not merge an inferred current year (#622)', () => {
    const history = buildAssessmentHistory(
      rows([2025, 900_000, null]),
      { ...RECORD, assessmentYearInferred: true },
      null,
    );
    expect(history).toEqual([{ rollYear: 2025, assessedValue: 900_000 }]);
  });

  it('returns [] for an address with no history rows', () => {
    expect(buildAssessmentHistory([], RECORD, '80196603')).toEqual([]);
  });

  it('uses only the matching parcel when several parcels share the address', () => {
    const history = buildAssessmentHistory(
      rows([2025, 900_000, '80196603'], [2025, 5_000_000, '99999999'], [2024, 800_000, '80196603']),
      RECORD,
      '80196603',
    );
    expect(history).toEqual([
      { rollYear: 2026, assessedValue: 2_770_000 },
      { rollYear: 2025, assessedValue: 900_000 },
      { rollYear: 2024, assessedValue: 800_000 },
    ]);
  });

  it('falls back to every row at the address when no roll number matches', () => {
    const history = buildAssessmentHistory(
      rows([2025, 900_000, '11111111'], [2025, 950_000, '22222222']),
      RECORD,
      '80196603',
    );
    expect(history[1]).toEqual({ rollYear: 2025, assessedValue: 950_000 });
  });
});

describe('assessment service (#695)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC1: current record + prior years, newest first, integers, no duplicates', async () => {
    stubCity();
    const res = await makeService().getAssessment(KEY);

    expect(res.property.addressKey).toBe(KEY);
    expect(res.property.assessedValue).toBe(2_770_000);
    expect(res.cityRecordUpdatedOn).toBe('2026-01-14');
    expect(res.propertyClassLabel).toBe('Residential');
    expect(res.historyAvailable).toBe(true);
    expect(res.history).toEqual([
      { rollYear: 2026, assessedValue: 2_770_000 },
      { rollYear: 2025, assessedValue: 2_630_000 },
      { rollYear: 2024, assessedValue: 2_170_000 },
      { rollYear: 2023, assessedValue: 1_970_000 },
      { rollYear: 2022, assessedValue: 1_950_000 },
      { rollYear: 2021, assessedValue: 1_790_000 },
      { rollYear: 2014, assessedValue: 1_700_000 },
    ]);
    const years = res.history.map((p) => p.rollYear);
    expect(new Set(years).size).toBe(years.length);
    expect(res.history.every((p) => Number.isInteger(p.assessedValue))).toBe(true);
    expect(res.history.filter((p) => p.rollYear < res.property.assessmentYear).length)
      .toBeGreaterThanOrEqual(5);
  });

  it('queries the history dataset by exact address with fixed $select/$order/$limit', async () => {
    stubCity();
    await makeService().getAssessment(KEY);
    const url = vi
      .mocked(fetch)
      .mock.calls.map(([u]) => new URL(String(u)))
      .find((u) => u.pathname.endsWith('/4ur7-wsgc.json'));
    expect(url).toBeDefined();
    expect(url?.searchParams.get('$where')).toBe(`address='${KEY}'`);
    expect(url?.searchParams.get('$select')).toBe('roll_year,roll_number,address,assessed_value');
    expect(url?.searchParams.get('$order')).toBe('roll_year DESC');
    expect(url?.searchParams.get('$limit')).toBe('500');
  });

  it('drops history rows without a parseable year or value, and other addresses', async () => {
    stubCity(
      [CURRENT],
      [
        historyRow(2025, '2,630,000'),
        historyRow('', '1,000,000'),
        historyRow('20x4', '1,000,000'),
        historyRow(2023, ''),
        historyRow(2022, 'n/a'),
        { ...historyRow(2021, '9,999,999'), address: '1414 PROSPECT AV SW' },
      ],
    );
    const res = await makeService().getAssessment(KEY);
    expect(res.history).toEqual([
      { rollYear: 2026, assessedValue: 2_770_000 },
      { rollYear: 2025, assessedValue: 2_630_000 },
    ]);
  });

  it('matches history across the leading-zero roll-number mismatch', async () => {
    stubCity(
      [CURRENT],
      [
        historyRow(2025, '2,630,000', '80196603'),
        // Another parcel at the same address — must not win on value.
        historyRow(2025, '9,000,000', '12345678'),
      ],
    );
    const res = await makeService().getAssessment(KEY);
    expect(res.history[1]).toEqual({ rollYear: 2025, assessedValue: 2_630_000 });
  });

  it('address with no history (new subdivision) → historyAvailable false, history []', async () => {
    stubCity([CURRENT], []);
    const res = await makeService().getAssessment(KEY);
    expect(res.property.assessedValue).toBe(2_770_000);
    expect(res.history).toEqual([]);
    expect(res.historyAvailable).toBe(false);
  });

  it.each<Mode>(['http-500', 'down', 'hang'])(
    'AC2: history outage (%s) → current record, historyAvailable false, one warning',
    async (mode) => {
      const city = stubCity();
      city.history.mode = mode;
      const warnings: string[] = [];
      const res = await makeService(warnings).getAssessment(KEY, { correlationId: 'corr-7' });
      expect(res.property.assessedValue).toBe(2_770_000);
      expect(res.history).toEqual([]);
      expect(res.historyAvailable).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('correlationId=corr-7');
      expect(warnings[0]).not.toContain(KEY);
    },
  );

  it('a history outage is not cached — the next request retries the City', async () => {
    const city = stubCity();
    city.history.mode = 'http-500';
    const service = makeService();
    expect((await service.getAssessment(KEY)).historyAvailable).toBe(false);
    city.history.mode = 'ok';
    expect((await service.getAssessment(KEY)).historyAvailable).toBe(true);
    expect(city.calls('4ur7-wsgc')).toBe(2);
  });

  it.each<Mode>(['http-500', 'down', 'hang'])(
    'AC2: current-year outage (%s) → 503 DEPENDENCY_UNAVAILABLE',
    async (mode) => {
      const city = stubCity();
      city.current.mode = mode;
      await expect(makeService().getAssessment(KEY)).rejects.toMatchObject({
        status: 503,
        code: ErrorCodes.DEPENDENCY_UNAVAILABLE,
      });
    },
  );

  it('AC3: unknown address → 404 ADDRESS_NOT_FOUND', async () => {
    stubCity([], []);
    await expect(makeService().getAssessment('9999 NOWHERE ST SW')).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.ADDRESS_NOT_FOUND,
    });
  });

  it('AC3: out-of-coverage key → 404 OUT_OF_COVERAGE without any City call', async () => {
    const city = stubCity();
    await expect(makeService().getAssessment('123 KING ST W TORONTO')).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.OUT_OF_COVERAGE,
    });
    expect(city.calls('4bsw-nn7w') + city.calls('4ur7-wsgc')).toBe(0);
  });

  it('AC4: non-residential and multi-unit parcels get a normal response', async () => {
    const nonResidential = {
      ...CURRENT,
      assessment_class: 'NR',
      assessment_class_description: 'NON-RESIDENTIAL',
      property_type: 'LO',
    };
    stubCity([nonResidential], HISTORY);
    const nr = await makeService().getAssessment(KEY);
    expect(nr.property.isNonResidential).toBe(true);
    expect(nr.propertyClassLabel).toBe('Non-residential');
    expect(nr.historyAvailable).toBe(true);

    vi.unstubAllGlobals();
    const unitKey = `201 ${KEY}`;
    stubCity(
      [{ ...CURRENT, address: unitKey, property_type: 'CO' }],
      [{ ...historyRow(2025, '450,000'), address: unitKey }],
    );
    const unit = await makeService().getAssessment(unitKey);
    expect(unit.property.addressKey).toBe(unitKey);
    expect(unit.history.map((p) => p.rollYear)).toEqual([2026, 2025]);
  });

  it('cityRecordUpdatedOn is null and the label falls back to the class code', async () => {
    const { mod_date: _omit, assessment_class_description: _d, ...bare } = CURRENT;
    stubCity([bare], HISTORY);
    const res = await makeService().getAssessment(KEY);
    expect(res.cityRecordUpdatedOn).toBeNull();
    expect(res.propertyClassLabel).toBe('Residential');
  });

  it('caches history: a second request makes no City call; durable tier keyed by dataset', async () => {
    const city = stubCity();
    const store = memoryStore();
    const service = makeService([], store);
    await service.getAssessment(KEY);
    await service.getAssessment(KEY);
    expect(city.calls('4ur7-wsgc')).toBe(1);
    expect(city.calls('4bsw-nn7w')).toBe(1);
    expect(store.keys.some((k) => k.startsWith('4ur7-wsgc:') && k.endsWith(KEY))).toBe(true);

    // A fresh instance (another Function host) reads the durable tier.
    const other = makeService([], store);
    const res = await other.getAssessment(KEY);
    expect(res.historyAvailable).toBe(true);
    expect(city.calls('4ur7-wsgc')).toBe(1);
  });

  it('AC5: the response conforms to the published OpenAPI schema', async () => {
    stubCity();
    const res = await makeService().getAssessment(KEY);
    expect(() => PropertyAssessmentResponseSchema.strict().parse(res)).not.toThrow();

    vi.unstubAllGlobals();
    const city = stubCity();
    city.history.mode = 'down';
    const degraded = await makeService().getAssessment(KEY);
    expect(() => PropertyAssessmentResponseSchema.strict().parse(degraded)).not.toThrow();
  });
});
