/**
 * Drizzle-backed shared City-data cache (#756).
 *
 * Durable second tier behind the property service's in-memory cache: an
 * assessment-roll record or a land-use district fetched by one instance is
 * reused by every other instance until it expires (per-dataset TTL from
 * config). Only public City open data is stored.
 *
 * Only services import from this module (layer boundary: routes never touch
 * the db directly).
 */
import { and, eq, gt, lt } from 'drizzle-orm';
import { cityDataCache } from '../db/schema';

export interface CityDataCacheStore {
  /** Cached payload for (dataset, key), or undefined when absent/expired. */
  get(datasetId: string, key: string, now: Date): Promise<unknown>;
  /** Upserts the payload for (dataset, key) until `expiresAt`. */
  put(datasetId: string, key: string, payload: unknown, expiresAt: Date): Promise<void>;
}

/**
 * #757: drops a dataset's entries fetched before the City last updated it,
 * so the next lookup re-reads the City (the zoning watcher's refresh).
 */
export interface CityDataCacheInvalidator {
  /** Deletes `datasetId` rows fetched before `fetchedBefore`; resolves the count removed. */
  invalidateDataset(datasetId: string, fetchedBefore: Date): Promise<number>;
}

export interface DrizzleCityDataCacheStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

/** Row key: dataset-scoped so two datasets never share an entry. */
export function cityDataCacheKey(datasetId: string, key: string): string {
  return `${datasetId}:${key}`;
}

export function createDrizzleCityDataCacheStore(
  deps: DrizzleCityDataCacheStoreDeps,
): CityDataCacheStore & CityDataCacheInvalidator {
  const { db } = deps;
  const t = cityDataCache;
  return {
    async get(datasetId, key, now): Promise<unknown> {
      const rows: Array<{ payload: unknown }> = await db
        .select({ payload: t.payload })
        .from(t)
        .where(and(eq(t.key, cityDataCacheKey(datasetId, key)), gt(t.expiresAt, now)))
        .limit(1);
      return rows[0]?.payload;
    },

    async put(datasetId, key, payload, expiresAt): Promise<void> {
      const fetchedAt = new Date();
      await db
        .insert(t)
        .values({ key: cityDataCacheKey(datasetId, key), datasetId, payload, fetchedAt, expiresAt })
        .onConflictDoUpdate({
          target: t.key,
          set: { payload, fetchedAt, expiresAt },
        });
    },

    async invalidateDataset(datasetId, fetchedBefore): Promise<number> {
      const rows: Array<{ key: string }> = await db
        .delete(t)
        .where(and(eq(t.datasetId, datasetId), lt(t.fetchedAt, fetchedBefore)))
        .returning({ key: t.key });
      return rows.length;
    },
  };
}
