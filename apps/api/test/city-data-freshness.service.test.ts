/**
 * City-data freshness service tests (trust-strip/01).
 *
 * The Socrata metadata HTTP layer is mocked (global fetch stub); these
 * tests cover: fresh fetch → "Month Year" from rowsUpdatedAt plus the
 * latest roll_year (#513), 24h cache hit (no second fetch), cache expiry
 * re-fetches, Socrata failure / missing field → null (never throws, never
 * caches failed or partial answers).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createCityDataFreshnessService,
  formatRefreshedMonth,
  parseRollYear,
  type CityDataFreshnessService,
} from '../src/services/city-data-freshness.service';
import type { CityDataFreshnessConfig } from '../src/config';

const CONFIG: CityDataFreshnessConfig = {
  socrataBaseUrl: 'https://data.calgary.ca',
  datasetId: '4bsw-nn7w',
  httpTimeoutMs: 5_000,
  // Short TTL keeps the expiry test fast; the real 24h default is asserted
  // in config.test.ts.
  cacheTtlMs: 1_000,
};

/** rowsUpdatedAt 1790694657 = 2026-09-30T…Z → "September 2026" (UTC). */
const METADATA = { rowsUpdatedAt: 1790694657 };

const ROLL_ROWS = [{ roll_year: '2026' }];
const FULL = { refreshedMonth: 'September 2026', rollYear: 2026 };

interface Reply {
  readonly body: unknown;
  readonly ok?: boolean;
}

/**
 * Routes the stubbed fetch by URL: the metadata view vs the roll-year SoQL
 * resource. `null` = transport failure for that request.
 */
function mockSocrata(metadata: Reply | null, roll: Reply | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    const reply = String(url).includes('/api/views/') ? metadata : roll;
    if (reply === null) throw new Error('network down');
    return { ok: reply.ok ?? true, json: async () => reply.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockHealthy(): ReturnType<typeof vi.fn> {
  return mockSocrata({ body: METADATA }, { body: ROLL_ROWS });
}

describe('city-data freshness service', () => {
  let service: CityDataFreshnessService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = createCityDataFreshnessService(CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('formatRefreshedMonth', () => {
    it('formats epoch seconds as "Month Year" in UTC', () => {
      expect(formatRefreshedMonth(1790694657)).toBe('September 2026');
    });

    it('accepts a numeric string', () => {
      expect(formatRefreshedMonth('1790694657')).toBe('September 2026');
    });

    it('returns null for missing, zero, negative, or non-numeric values', () => {
      expect(formatRefreshedMonth(undefined)).toBeNull();
      expect(formatRefreshedMonth(null)).toBeNull();
      expect(formatRefreshedMonth(0)).toBeNull();
      expect(formatRefreshedMonth(-5)).toBeNull();
      expect(formatRefreshedMonth('not-a-number')).toBeNull();
      expect(formatRefreshedMonth('')).toBeNull();
    });
  });

  describe('parseRollYear', () => {
    it('reads the first row roll_year (string or number)', () => {
      expect(parseRollYear([{ roll_year: '2026' }])).toBe(2026);
      expect(parseRollYear([{ roll_year: 2025 }])).toBe(2025);
    });

    it('returns null for anything that is not a four-digit year row', () => {
      expect(parseRollYear(undefined)).toBeNull();
      expect(parseRollYear([])).toBeNull();
      expect(parseRollYear({ roll_year: '2026' })).toBeNull();
      expect(parseRollYear([{}])).toBeNull();
      expect(parseRollYear([{ roll_year: 'soon' }])).toBeNull();
      expect(parseRollYear([{ roll_year: '26' }])).toBeNull();
      expect(parseRollYear([null])).toBeNull();
    });
  });

  it('fetches metadata + latest roll year and returns both', async () => {
    const fetchMock = mockHealthy();
    const res = await service.getFreshness();
    expect(res).toEqual(FULL);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://data.calgary.ca/api/views/4bsw-nn7w');
    expect(urls).toContain(
      'https://data.calgary.ca/resource/4bsw-nn7w.json?$select=roll_year&$order=roll_year%20DESC&$limit=1',
    );
  });

  it('serves the second call from the 24h in-memory cache (no second fetch)', async () => {
    const fetchMock = mockHealthy();
    await service.getFreshness();
    const res = await service.getFreshness();
    expect(res).toEqual(FULL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after the cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockHealthy();
      await service.getFreshness();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(CONFIG.cacheTtlMs + 1);
      const res = await service.getFreshness();
      expect(res).toEqual(FULL);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Socrata transport failure → both null (never throws)', async () => {
    mockSocrata(null, null);
    await expect(service.getFreshness()).resolves.toEqual({ refreshedMonth: null, rollYear: null });
  });

  it('non-OK Socrata responses → both null (never throws)', async () => {
    mockSocrata({ body: { message: 'upstream error' }, ok: false }, { body: [], ok: false });
    await expect(service.getFreshness()).resolves.toEqual({ refreshedMonth: null, rollYear: null });
  });

  it('missing rowsUpdatedAt → null month, roll year still served', async () => {
    mockSocrata(
      { body: { id: '4bsw-nn7w', name: 'Current Year Property Assessments (Parcel)' } },
      { body: ROLL_ROWS },
    );
    await expect(service.getFreshness()).resolves.toEqual({ refreshedMonth: null, rollYear: 2026 });
  });

  it('roll-year query failure → null roll year, month still served', async () => {
    mockSocrata({ body: METADATA }, null);
    await expect(service.getFreshness()).resolves.toEqual({
      refreshedMonth: 'September 2026',
      rollYear: null,
    });
  });

  it('never caches failures: a failed fetch is retried on the next call', async () => {
    mockSocrata(null, null);
    await service.getFreshness();
    const fetchMock = mockHealthy();
    const res = await service.getFreshness();
    expect(res).toEqual(FULL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never caches partial answers: a missing roll year is retried', async () => {
    mockSocrata({ body: METADATA }, null);
    await service.getFreshness();
    const fetchMock = mockHealthy();
    await expect(service.getFreshness()).resolves.toEqual(FULL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
