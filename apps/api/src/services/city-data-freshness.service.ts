/**
 * City-data freshness service (trust-strip/01).
 *
 * Derives the shared freshness line ("{rollYear} assessment roll (City of
 * Calgary) · checked {Mon Year}", #513) from the City of Calgary Property
 * Assessment dataset on Socrata:
 * - `refreshedMonth`: the dataset metadata's `rowsUpdatedAt`
 *   (`GET /api/views/{datasetId}`);
 * - `rollYear`: the latest `roll_year` in the dataset
 *   (`GET /resource/{datasetId}.json?$select=roll_year&$order=roll_year DESC&$limit=1`).
 *   Both requests run in parallel.
 *
 * - In-memory cache, 24h TTL on fully SUCCESSFUL fetches only (both values
 *   read; config `cityDataFreshness.cacheTtlMs`). Failed or partial fetches
 *   are never cached — the next request retries Socrata immediately.
 * - Never throws: a Socrata failure or a missing/unparseable value
 *   resolves that field to null (`{ refreshedMonth: null, rollYear: null }`) so the route
 *   answers 200 and the frontend shows its honest fallback ("Live City
 *   data") instead of a month it can't verify.
 * - Fetch-only: no db, no process.env (config arrives via deps).
 */
import type { CityDataFreshnessConfig } from '../config';

/** The freshness answer: each field null when unknown. */
export interface CityDataFreshness {
  /** "Month Year" the dataset was last refreshed. */
  readonly refreshedMonth: string | null;
  /** Latest assessment roll year in the dataset (e.g. 2026). */
  readonly rollYear: number | null;
}

export interface CityDataFreshnessService {
  /** Never throws — a Socrata failure resolves the affected field to null. */
  getFreshness(): Promise<CityDataFreshness>;
}

/**
 * Formats a Socrata `rowsUpdatedAt` epoch-seconds value as "Month Year"
 * ("September 2026"). Null when the value is missing or unparseable.
 * Pure — unit-testable without I/O.
 */
export function formatRefreshedMonth(rowsUpdatedAt: unknown): string | null {
  const epochSeconds =
    typeof rowsUpdatedAt === 'number'
      ? rowsUpdatedAt
      : typeof rowsUpdatedAt === 'string' && rowsUpdatedAt.trim() !== ''
        ? Number(rowsUpdatedAt)
        : Number.NaN;
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  // UTC: the metadata is a dataset-publish timestamp, not a local time —
  // formatting in UTC keeps it deterministic across instances.
  const formatted = date.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return formatted === 'Invalid Date' ? null : formatted;
}

/**
 * Parses the latest-roll-year SoQL answer (`[{ "roll_year": "2026" }]`).
 * Null when the body is not that shape or the year is not a plausible
 * four-digit year. Pure — unit-testable without I/O.
 */
export function parseRollYear(body: unknown): number | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const first: unknown = body[0];
  if (first === null || typeof first !== 'object') return null;
  const raw = (first as Record<string, unknown>)['roll_year'];
  const year =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{4}$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
}

/** Unknown shape from the Socrata metadata endpoint. */
function rowsUpdatedAtOf(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return undefined;
  return (body as Record<string, unknown>)['rowsUpdatedAt'];
}

export function createCityDataFreshnessService(
  config: CityDataFreshnessConfig,
): CityDataFreshnessService {
  const metadataUrl = `${config.socrataBaseUrl}/api/views/${config.datasetId}`;
  const rollYearUrl =
    `${config.socrataBaseUrl}/resource/${config.datasetId}.json` +
    '?$select=roll_year&$order=roll_year%20DESC&$limit=1';
  let cached: { expires: number; value: CityDataFreshness } | undefined;

  /** GET a JSON body; undefined on any transport/HTTP failure (never throws). */
  async function fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return undefined;
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getFreshness: async (): Promise<CityDataFreshness> => {
      const now = Date.now();
      if (cached && now <= cached.expires) {
        return cached.value;
      }
      cached = undefined;
      const [metadata, rollRows] = await Promise.all([
        fetchJson(metadataUrl),
        fetchJson(rollYearUrl),
      ]);
      const value: CityDataFreshness = {
        refreshedMonth: formatRefreshedMonth(rowsUpdatedAtOf(metadata)),
        rollYear: parseRollYear(rollRows),
      };
      // Cache complete answers only — a failure (or partial answer) leaves
      // the cache empty so the next request retries Socrata instead of
      // serving a stale null for 24h.
      if (value.refreshedMonth !== null && value.rollYear !== null) {
        cached = { expires: now + config.cacheTtlMs, value };
      }
      return value;
    },
  };
}
