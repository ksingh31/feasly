/**
 * City-data cache store integration (#756): migration 0053 against PGlite,
 * get/put round-trip, expiry, upsert, dataset scoping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cityDataCacheKey,
  createDrizzleCityDataCacheStore,
} from '../src/services/city-data-cache.store';
import { createTestDb, type TestDb } from './pglite-db';

describe('city-data cache store (#756)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  const now = new Date('2026-11-16T00:00:00Z');
  const later = new Date('2026-11-23T00:00:00Z');

  it('round-trips a JSON payload until it expires', async () => {
    const store = createDrizzleCityDataCacheStore({ db: testDb.db });
    const payload = { record: { addressKey: '1 A ST NW', assessedValue: 500_000 }, point: null };
    await store.put('4bsw-nn7w', '1 A ST NW', payload, later);
    expect(await store.get('4bsw-nn7w', '1 A ST NW', now)).toEqual(payload);
    // At/after expiry it is a miss.
    expect(await store.get('4bsw-nn7w', '1 A ST NW', later)).toBeUndefined();
  });

  it('upserts: a re-fetch replaces the payload and the expiry', async () => {
    const store = createDrizzleCityDataCacheStore({ db: testDb.db });
    await store.put('qe6k-p9nh', '2 B ST NW', { v: 1 }, now);
    expect(await store.get('qe6k-p9nh', '2 B ST NW', now)).toBeUndefined();
    await store.put('qe6k-p9nh', '2 B ST NW', { v: 2 }, later);
    expect(await store.get('qe6k-p9nh', '2 B ST NW', now)).toEqual({ v: 2 });
    const rows = await testDb.rows<{ n: number }>(
      `select count(*)::int as n from city_data_cache where key = '${cityDataCacheKey('qe6k-p9nh', '2 B ST NW')}'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('scopes entries by dataset', async () => {
    const store = createDrizzleCityDataCacheStore({ db: testDb.db });
    await store.put('dataset-a', '3 C ST NW', { a: true }, later);
    expect(await store.get('dataset-b', '3 C ST NW', now)).toBeUndefined();
    expect(await store.get('dataset-a', '3 C ST NW', now)).toEqual({ a: true });
  });
});
