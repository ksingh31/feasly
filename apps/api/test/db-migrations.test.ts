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

  it('creates the estimates, leads, lead_notes, and lead_status_history tables', async () => {
    const rows = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('estimates', 'leads', 'lead_notes', 'lead_status_history')`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual([
      'estimates',
      'lead_notes',
      'lead_status_history',
      'leads',
    ]);
  });

  it('adds lead_score and status columns with safe defaults (consumer/02)', async () => {
    const cols = await testDb.rows<{
      column_name: string;
      column_default: string | null;
    }>(
      `select column_name, column_default from information_schema.columns where table_name = 'leads' and column_name in ('lead_score', 'status')`,
    );
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.column_default]));
    expect(byName['lead_score']).toBe('0');
    expect(byName['status']).toBe("'new'::text");
    const idx = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename in ('lead_notes', 'lead_status_history')`,
    );
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('lead_notes_lead_id_idx');
    expect(names).toContain('lead_status_history_lead_id_idx');
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
      projectType: 'new_build',
      addressKey: 'calgary-123-fake-st-nw',
      inputs: { sqft: 2200, tier: 'standard', garage: 'none', basement: 'unfinished' },
      figures: { build: { low: 1, base: 2, high: 2 }, total: { low: 1, base: 2, high: 3 }, land: { low: 1, base: 1, high: 1 } },
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
        projectType: 'new_build',
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
    // Window bounds are relative to now so the test is date-independent
    // (issue #52: hardcoded 2026-09-25 became a time bomb).
    const hitOther = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    expect(hitOther?.id).toBe(inserted.id);

    // Inside the window → found.
    const hit = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    expect(hit?.id).toBe(inserted.id);

    // Outside the window → not found. `since` is derived from the wall
    // clock, never hardcoded — a fixed date becomes "inside the window"
    // as soon as the calendar passes it.
    const miss = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(miss).toBeNull();

    // Different address → not found.
    const other = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey: 'calgary-000-other-st-nw',
      since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    expect(other).toBeNull();
  });
});

describe('migration 0001 — estimates.project_type', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('adds project_type with a new_build default', async () => {
    const cols = await testDb.rows<{ column_name: string; column_default: string | null }>(
      `select column_name, column_default from information_schema.columns where table_name = 'estimates' and column_name = 'project_type'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].column_default).toContain('new_build');
  });

  it('round-trips project_type through the Drizzle store', async () => {
    const store = createDrizzleEstimateStore({ db: testDb.db });
    const id = '33333333-3333-4333-8333-333333333333';
    await store.save({
      id,
      projectType: 'renovation',
      addressKey: 'calgary-reno-migration-test',
      inputs: { renoType: 'basement' },
      figures: {},
      rows: [],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt: new Date(),
    });
    const found = await store.findById(id);
    expect(found?.projectType).toBe('renovation');
  });
});

describe('migration 0002 — leads.quarantined', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('adds quarantined with a false default', async () => {
    const cols = await testDb.rows<{ column_name: string; column_default: string | null }>(
      `select column_name, column_default from information_schema.columns where table_name = 'leads' and column_name = 'quarantined'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].column_default).toContain('false');
  });

  it('round-trips quarantined through the Drizzle store', async () => {
    const estimates = createDrizzleEstimateStore({ db: testDb.db });
    const leads = createDrizzleLeadStore({ db: testDb.db });
    const estimateId = '44444444-4444-4333-8444-444444444444';
    await estimates.save({
      id: estimateId,
      projectType: 'new_build',
      addressKey: 'calgary-quarantine-test',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt: new Date(),
    });
    const clean = await leads.insert({
      id: '55555555-5555-4333-8555-555555555555',
      estimateId,
      addressKey: 'calgary-quarantine-test',
      email: 'clean@example.com',
      name: 'Clean',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: new Date('2026-09-24T12:00:00Z'),
      source: 'api',
    });
    expect(clean.quarantined).toBe(false);
    const trapped = await leads.insert({
      id: '66666666-6666-4333-8666-666666666666',
      estimateId,
      addressKey: 'calgary-quarantine-test',
      email: 'bot@example.com',
      name: 'Bot',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: new Date('2026-09-24T12:01:00Z'),
      source: 'api',
      quarantined: true,
    });
    expect(trapped.quarantined).toBe(true);

    // Default listing excludes quarantined rows — newest first.
    const listed = await leads.listLeads();
    expect(listed.map((r) => r.email)).toEqual(['clean@example.com']);

    // The admin quarantine tab opts in explicitly.
    const all = await leads.listLeads({ includeQuarantined: true });
    expect(all.map((r) => r.email)).toEqual(['bot@example.com', 'clean@example.com']);
  });
});
