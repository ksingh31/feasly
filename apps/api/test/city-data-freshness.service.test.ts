/**
 * City-data freshness service tests (trust-strip/01).
 *
 * The Socrata metadata HTTP layer is mocked (global fetch stub); these
 * tests cover: fresh fetch → "Month Year" from rowsUpdatedAt, 24h cache
 * hit (no second fetch), cache expiry re-fetches, Socrata failure /
 * missing field → null (never throws, never caches failures).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createCityDataFreshnessService,
  formatRefreshedMonth,
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

function mockFetchOnce(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockFetchRejected(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('network down')),
  );
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

  it('fetches the Socrata metadata and returns the refresh month', async () => {
    const fetchMock = mockFetchOnce(METADATA);
    const res = await service.getFreshness();
    expect(res).toEqual({ refreshedMonth: 'September 2026' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('https://data.calgary.ca/api/views/4bsw-nn7w');
  });

  it('serves the second call from the 24h in-memory cache (no second fetch)', async () => {
    const fetchMock = mockFetchOnce(METADATA);
    await service.getFreshness();
    const res = await service.getFreshness();
    expect(res).toEqual({ refreshedMonth: 'September 2026' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetchOnce(METADATA);
      await service.getFreshness();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CONFIG.cacheTtlMs + 1);
      const res = await service.getFreshness();
      expect(res).toEqual({ refreshedMonth: 'September 2026' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Socrata transport failure → null (never throws)', async () => {
    mockFetchRejected();
    await expect(service.getFreshness()).resolves.toEqual({ refreshedMonth: null });
  });

  it('non-OK Socrata response → null (never throws)', async () => {
    mockFetchOnce({ message: 'upstream error' }, false);
    await expect(service.getFreshness()).resolves.toEqual({ refreshedMonth: null });
  });

  it('missing rowsUpdatedAt → null', async () => {
    mockFetchOnce({ id: '4bsw-nn7w', name: 'Current Year Property Assessments (Parcel)' });
    await expect(service.getFreshness()).resolves.toEqual({ refreshedMonth: null });
  });

  it('never caches failures: a failed fetch is retried on the next call', async () => {
    mockFetchRejected();
    await service.getFreshness();
    const fetchMock = mockFetchOnce(METADATA);
    const res = await service.getFreshness();
    expect(res).toEqual({ refreshedMonth: 'September 2026' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
