/**
 * Usage store integration tests (api-mcp/07).
 *
 * Runs the real migration SQL (including 0012_api_usage.sql) against
 * PGlite and exercises the Drizzle store end to end: no fakes below the
 * service layer here. Covers:
 *  - 0012 creates the api_usage table
 *  - insert + countSince + oldestSince
 *  - aggregate: per-day counts by endpoint + estimates_created
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDrizzleUsageStore } from '../src/services/usage.store';
import { createDrizzleApiKeyStore } from '../src/services/api-key.store';
import { hashApiKey } from '../src/services/api-key.service';
import { createTestDb, type TestDb } from './pglite-db';

describe('usage store integration (api-mcp/07)', () => {
  let testDb: TestDb;
  let keyId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    // Seed one API key for the FK.
    const keys = createDrizzleApiKeyStore({ db: testDb.db });
    keyId = randomUUID();
    await keys.insert({
      id: keyId,
      name: 'Usage test key',
      tenantId: null,
      keyHash: hashApiKey('feasly_live_USAGETESTUSAGETESTUSAGETEST12'),
      keyPrefix: 'feasly_live_…T12',
      scopes: ['estimate'],
      rateLimitPerMin: 5,
      sandbox: false,
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('migration 0012 creates the api_usage table', async () => {
    const rows = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = 'api_usage'`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['api_usage']);
  });

  it('insert + countSince + oldestSince round-trip', async () => {
    const store = createDrizzleUsageStore({ db: testDb.db });
    const now = new Date();
    await store.insert({
      id: randomUUID(),
      apiKeyId: keyId,
      endpoint: '/api/v1/estimate',
      estimateId: null,
      createdAt: now,
    });
    await store.insert({
      id: randomUUID(),
      apiKeyId: keyId,
      endpoint: '/api/v1/estimate',
      estimateId: randomUUID(),
      createdAt: now,
    });

    const since = new Date(now.getTime() - 60_000);
    expect(await store.countSince(keyId, since)).toBe(2);
    const oldest = await store.oldestSince(keyId, since);
    expect(oldest).not.toBeNull();
    // Oldest is at-or-before now (insertion order).
    expect(oldest!.getTime()).toBeLessThanOrEqual(now.getTime());

    // A window starting after the inserts sees nothing.
    const future = new Date(now.getTime() + 1000);
    expect(await store.countSince(keyId, future)).toBe(0);
    expect(await store.oldestSince(keyId, future)).toBeNull();
  });

  it('aggregate: per-day counts by endpoint + estimates_created', async () => {
    const store = createDrizzleUsageStore({ db: testDb.db });
    // Use a fresh key so earlier tests' rows don't pollute the aggregate.
    const keys = createDrizzleApiKeyStore({ db: testDb.db });
    const freshKeyId = randomUUID();
    await keys.insert({
      id: freshKeyId,
      name: 'Aggregate test key',
      tenantId: null,
      keyHash: hashApiKey('feasly_live_AGGREGATEAGGREGATEAGGREGATE1'),
      keyPrefix: 'feasly_live_…GTE1',
      scopes: ['estimate'],
      rateLimitPerMin: 100,
      sandbox: false,
    });

    const now = new Date();
    await store.insert({
      id: randomUUID(),
      apiKeyId: freshKeyId,
      endpoint: '/api/v1/estimate',
      estimateId: randomUUID(),
      createdAt: now,
    });
    await store.insert({
      id: randomUUID(),
      apiKeyId: freshKeyId,
      endpoint: '/api/v1/estimate',
      estimateId: null,
      createdAt: now,
    });
    await store.insert({
      id: randomUUID(),
      apiKeyId: freshKeyId,
      endpoint: '/api/v1/properties/lookup',
      estimateId: null,
      createdAt: now,
    });

    const agg = await store.aggregate({ apiKeyId: freshKeyId });
    const byEndpoint = new Map(agg.map((a) => [a.endpoint, a]));
    expect(byEndpoint.get('/api/v1/estimate')?.count).toBe(2);
    expect(byEndpoint.get('/api/v1/estimate')?.estimatesCreated).toBe(1);
    expect(byEndpoint.get('/api/v1/properties/lookup')?.count).toBe(1);
    expect(byEndpoint.get('/api/v1/properties/lookup')?.estimatesCreated).toBe(0);
    // Date is YYYY-MM-DD.
    expect(byEndpoint.get('/api/v1/estimate')?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
