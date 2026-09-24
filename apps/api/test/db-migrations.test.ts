/**
 * Migration + Drizzle store integration tests (BE1-001 / BE-3).
 *
 * Runs the real migration SQL (the same files `db:migrate` applies in the
 * deploy pipeline) against an in-process Postgres (PGlite), then exercises
 * the Drizzle store implementations end to end: no fakes below the service
 * layer here.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createTestDb, type TestDb } from './pglite-db';

describe('migrations', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('creates the estimates and leads tables', async () => {
    const rows = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('estimates', 'leads')`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(['estimates', 'leads']);
  });

  it('creates the leads foreign key and the lookup indexes', async () => {
    const idx = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename in ('estimates', 'leads')`,
    );
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('leads_address_email_created_idx');
    expect(names).toContain('estimates_address_key_idx');
    const fk = await testDb.rows<{ conname: string }>(
      `select conname from pg_constraint where conname = 'leads_estimate_id_estimates_id_fk'`,
    );
    expect(fk).toHaveLength(1);
  });

  it('rejects a lead whose estimate does not exist (FK integrity)', async () => {
    const leads = createDrizzleLeadStore({ db: testDb.db });
    await expect(
      leads.insert({
        id: '11111111-1111-4111-8111-111111111111',
        estimateId: '22222222-2222-4222-8222-222222222222',
        addressKey: 'calgary-999-fake-st-nw',
        email: 'nobody@example.com',
        name: 'Nobody',
        timeline: 'exploring',
        marketingConsent: false,
        consentTs: new Date(),
        source: 'api',
      }),
    ).rejects.toThrow();
  });
});

describe('drizzle stores', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('estimate store round-trips save → findById (insert-only)', async () => {
    const store = createDrizzleEstimateStore({ db: testDb.db });
    const createdAt = new Date('2026-09-24T12:00:00Z');
    await store.save({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      addressKey: 'calgary-123-fake-st-nw',
      inputs: { sqft: 2200, tier: 'standard', garage: 'none', basement: 'unfinished' },
      figures: { build: { low: 1, high: 2 }, total: { low: 1, high: 3 }, land: { low: 1, high: 1 } },
      rows: [],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt,
    });
    const found = await store.findById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(found?.addressKey).toBe('calgary-123-fake-st-nw');
    expect(found?.costDataVersion).toBe('v0.1.0-unclibrated');
    expect(found?.inputs).toEqual({
      sqft: 2200,
      tier: 'standard',
      garage: 'none',
      basement: 'unfinished',
    });
    expect(await store.findById('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBeNull();
  });

  it('lead store dedup lookup is (email, address) and honors the window bound', async () => {
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const estimateId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const otherEstimateId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const addressKey = 'calgary-456-fake-ave-nw';
    for (const id of [estimateId, otherEstimateId]) {
      await estimates.save({
        id,
        addressKey,
        inputs: {},
        figures: {},
        rows: [],
        costDataVersion: 'v0.1.0-unclibrated',
        createdAt: new Date(),
      });
    }
    const inserted = await leads.insert({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      estimateId,
      addressKey,
      email: 'sam@example.com',
      name: 'Sam',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: new Date('2026-09-24T12:00:00Z'),
      source: 'api',
    });
    expect(inserted.email).toBe('sam@example.com');
    expect(inserted.addressKey).toBe(addressKey);
    expect(inserted.marketingConsent).toBe(false);

    // Same email + same address on a DIFFERENT estimate → still found
    // (the household resubmitted; no duplicate lead).
    const hitOther = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date('2026-09-01T00:00:00Z'),
    });
    expect(hitOther?.id).toBe(inserted.id);

    // Inside the window → found.
    const hit = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date('2026-09-01T00:00:00Z'),
    });
    expect(hit?.id).toBe(inserted.id);

    // Outside the window → not found.
    const miss = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date('2026-09-25T00:00:00Z'),
    });
    expect(miss).toBeNull();

    // Different address → not found.
    const other = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey: 'calgary-000-other-st-nw',
      since: new Date('2026-09-01T00:00:00Z'),
    });
    expect(other).toBeNull();
  });
});
