/**
 * City-data freshness service (trust-strip/01).
 *
 * Derives the landing trust strip's "Refreshed <Month Year>" item from the
 * City of Calgary Property Assessment dataset's Socrata metadata
 * (`rowsUpdatedAt` on `GET /api/views/{datasetId}`).
 *
 * - In-memory cache, 24h TTL on SUCCESSFUL fetches only (config
 *   `cityDataFreshness.cacheTtlMs`). Failed fetches are never cached —
 *   the next request retries Socrata immediately.
 * - Never throws: a Socrata failure or a missing/unparseable
 *   `rowsUpdatedAt` resolves to `{ refreshedMonth: null }` so the route
 *   answers 200 and the frontend shows its honest fallback ("Live City
 *   data") instead of a month it can't verify.
 * - Fetch-only: no db, no process.env (config arrives via deps).
 */
import type { CityDataFreshnessConfig } from '../config';

/** The freshness answer: a "Month Year" string, or null when unknown. */
export interface CityDataFreshness {
  readonly refreshedMonth: string | null;
}

export interface CityDataFreshnessService {
  /** Never throws — Socrata failure resolves to `{ refreshedMonth: null }`. */
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

/** Unknown shape from the Socrata metadata endpoint. */
function rowsUpdatedAtOf(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return undefined;
  return (body as Record<string, unknown>)['rowsUpdatedAt'];
}

export function createCityDataFreshnessService(
  config: CityDataFreshnessConfig,
): CityDataFreshnessService {
  const metadataUrl = `${config.socrataBaseUrl}/api/views/${config.datasetId}`;
  let cached: { expires: number; value: string } | undefined;

  async function fetchRefreshedMonth(): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const res = await fetch(metadataUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return formatRefreshedMonth(rowsUpdatedAtOf(body));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getFreshness: async (): Promise<CityDataFreshness> => {
      const now = Date.now();
      if (cached && now <= cached.expires) {
        return { refreshedMonth: cached.value };
      }
      cached = undefined;
      const month = await fetchRefreshedMonth();
      // Cache successful fetches only — a failure leaves the cache empty so
      // the next request retries Socrata instead of serving a stale null.
      if (month !== null) {
        cached = { expires: now + config.cacheTtlMs, value: month };
      }
      return { refreshedMonth: month };
    },
  };
}
