/**
 * API key store integration tests (api-mcp/01).
 *
 * Runs the real migration SQL (including 0009_flowery_bullseye.sql) against
 * PGlite and exercises the Drizzle stores end to end: no fakes below the
 * service layer here. Covers:
 *  - scopes text[] round-trip
 *  - unique key_hash constraint
 *  - findActiveByHash excludes revoked rows
 *  - audit log insertion
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createDrizzleApiKeyAuditStore,
  createDrizzleApiKeyStore,
} from '../src/services/api-key.store';
import { hashApiKey } from '../src/services/api-key.service';
import { createTestDb, type TestDb } from './pglite-db';

describe('api-key store integration (api-mcp/01)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('migration 0009 creates the api_keys and api_key_audit_log tables', async () => {
    const rows = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('api_keys', 'api_key_audit_log')`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(['api_key_audit_log', 'api_keys']);
  });

  it('insert + findActiveByHash round-trips the scopes array', async () => {
    const store = createDrizzleApiKeyStore({ db: testDb.db });
    const keyHash = hashApiKey('feasly_live_TESTTESTTESTTESTTESTTESTTESTTEST');

    const inserted = await store.insert({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Partner A',
      tenantId: null,
      keyHash,
      keyPrefix: 'feasly_live_…TEST',
      scopes: ['property:read', 'estimate:read'],
      rateLimitPerMin: 100,
      sandbox: false,
    });

    expect(inserted.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(inserted.scopes).toEqual(['property:read', 'estimate:read']);

    const found = await store.findActiveByHash(keyHash);
    expect(found?.id).toBe(inserted.id);
    expect(found?.scopes).toEqual(['property:read', 'estimate:read']);
  });

  it('revoked keys are excluded from findActiveByHash and listActive', async () => {
    const store = createDrizzleApiKeyStore({ db: testDb.db });
    const keyHash = hashApiKey('feasly_live_REVOKEREVOKEREVOKEVOKEREVOKEVOKE');

    const inserted = await store.insert({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Doomed',
      tenantId: null,
      keyHash,
      keyPrefix: 'feasly_live_…VOKE',
      scopes: ['lead'],
      rateLimitPerMin: 100,
      sandbox: false,
    });
    await store.revoke(inserted.id, new Date());

    expect(await store.findActiveByHash(keyHash)).toBeNull();
    const active = await store.listActive();
    expect(active.some((k) => k.id === inserted.id)).toBe(false);
  });

  it('key_hash uniqueness is enforced at the DB level', async () => {
    const store = createDrizzleApiKeyStore({ db: testDb.db });
    const keyHash = hashApiKey('feasly_live_DUPEDUPEDUPEDUPEDUPEDUPEDUPEDUPE');
    const base = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Dupe 1',
      tenantId: null,
      keyHash,
      keyPrefix: 'feasly_live_…DUPE',
      scopes: ['lead'],
      rateLimitPerMin: 100,
      sandbox: false,
    };
    await store.insert(base);
    await expect(
      store.insert({ ...base, id: '66666666-6666-4666-8666-666666666666', name: 'Dupe 2' }),
    ).rejects.toThrow();
  });

  it('audit log rows are appended', async () => {
    const audit = createDrizzleApiKeyAuditStore({ db: testDb.db });
    await audit.log({
      apiKeyId: '33333333-3333-4333-8333-333333333333',
      action: 'created',
      detail: 'name=Partner A',
    });

    const rows = await testDb.rows<{ action: string; detail: string }>(
      `select action, detail from api_key_audit_log where api_key_id = '33333333-3333-4333-8333-333333333333'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'created', detail: 'name=Partner A' });
  });
});
