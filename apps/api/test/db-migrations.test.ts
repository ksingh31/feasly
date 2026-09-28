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
import { createDrizzleAdminSessionStore } from '../src/services/admin-auth.store';
import { attributionEvents } from '../src/db/schema';
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
      projectType: 'new_build',
      addressKey: 'calgary-123-fake-st-nw',
      inputs: { sqft: 2200, tier: 'standard', garage: 'none', basement: 'unfinished' },
      figures: { build: { low: 1, base: 2, high: 2 }, total: { low: 1, base: 2, high: 3 }, land: { low: 1, base: 1, high: 1 } },
      rows: [],
      costDataVersion: 'v0.1.0-unclibrated',
      createdAt,
      narrative: null,
      narrativeGeneratedAt: null,
      assumptions: null,
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

        narrative: null,
        narrativeGeneratedAt: null,
        assumptions: null,
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
      tenantKey: null,
    });
    expect(hitOther?.id).toBe(inserted.id);

    // Inside the window → found.
    const hit = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date('2026-09-01T00:00:00Z'),
      tenantKey: null,
    });
    expect(hit?.id).toBe(inserted.id);

    // Outside the window → not found. `since` is pinned just after "now"
    // (the insert happened milliseconds ago) so this stays correct no
    // matter what calendar day the suite runs on.
    const miss = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date(Date.now() + 60_000),
      tenantKey: null,
    });
    expect(miss).toBeNull();

    // Different address → not found.
    const other = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey: 'calgary-000-other-st-nw',
      since: new Date('2026-09-01T00:00:00Z'),
      tenantKey: null,
    });
    expect(other).toBeNull();

    // Tenant isolation: the same email + address captured by an embed
    // tenant is invisible to the direct-site lookup and vice versa.
    const tenantLead = await leads.insert({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      estimateId,
      addressKey,
      email: 'sam@example.com',
      name: 'Sam Tenant',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: new Date('2026-09-24T12:00:00Z'),
      tenantKey: 'elite-craft',
      source: 'embed',
    });
    const crossFromDirect = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date('2026-09-01T00:00:00Z'),
      tenantKey: null,
    });
    expect(crossFromDirect?.id).toBe(inserted.id);
    const tenantHit = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date('2026-09-01T00:00:00Z'),
      tenantKey: 'elite-craft',
    });
    expect(tenantHit?.id).toBe(tenantLead.id);
    const unknownTenant = await leads.findRecentByEmailAndAddress({
      email: 'sam@example.com',
      addressKey,
      since: new Date('2026-09-01T00:00:00Z'),
      tenantKey: 'someone-else',
    });
    expect(unknownTenant).toBeNull();
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

      narrative: null,
      narrativeGeneratedAt: null,
      assumptions: null,
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

      narrative: null,
      narrativeGeneratedAt: null,
      assumptions: null,
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

  it('creates the attribution_events table with its FK and indexes', async () => {
    const tables = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = 'attribution_events'`,
    );
    expect(tables.map((r) => r.table_name)).toEqual(['attribution_events']);

    const idx = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'attribution_events'`,
    );
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('attribution_events_lead_tenant_idx');
    expect(names).toContain('attribution_events_status_idx');

    const fk = await testDb.rows<{ conname: string }>(
      `select conname from pg_constraint where conname = 'attribution_events_lead_id_leads_id_fk'`,
    );
    expect(fk).toHaveLength(1);
  });

  it('rejects an attribution whose lead does not exist (FK integrity)', async () => {
    await expect(
      testDb.db.insert(attributionEvents).values({
        id: '66666666-6666-4666-8666-666666666666',
        leadId: '77777777-7777-4777-8777-777777777777',
        tenantKey: 'elite-craft-builders',
        introducedAt: new Date(),
        status: 'introduced',
      }),
    ).rejects.toThrow();
  });
});

describe('auth/04 session state migrations', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('adds active_builder_id and view_as to admin_sessions (0037)', async () => {
    const cols = await testDb.rows<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'admin_sessions' and column_name in ('active_builder_id', 'view_as')`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      'active_builder_id',
      'view_as',
    ]);
    const idx = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'admin_sessions'`,
    );
    expect(idx.map((i) => i.indexname)).toContain(
      'admin_sessions_active_builder_idx',
    );
  });

  it('adds builder_id to builder_sessions (0038)', async () => {
    const cols = await testDb.rows<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'builder_sessions' and column_name = 'builder_id'`,
    );
    expect(cols).toHaveLength(1);
    const idx = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'builder_sessions'`,
    );
    expect(idx.map((i) => i.indexname)).toContain(
      'builder_sessions_builder_id_idx',
    );
  });

  it('admin session store round-trips activeBuilderId and viewAs', async () => {
    const store = createDrizzleAdminSessionStore({ db: testDb.db });
    const now = new Date();
    await store.insert({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@example.com',
      sessionTokenHash: 'hash-1',
      expiresAt: new Date(now.getTime() + 3600_000),
      userId: null, // magic-link-era sessions allow null user_id
      activeBuilderId: null,
    });
    // active_builder_id references builders(id).
    await testDb.db.execute(
      `insert into builders (id, tenant_key, business_name, display_name) values ('33333333-3333-4333-8333-333333333333', 'elite-craft', 'Elite Craft', 'Elite Craft')`,
    );
    await store.updateState('hash-1', {
      activeBuilderId: '33333333-3333-4333-8333-333333333333',
      viewAs: { builderId: '33333333-3333-4333-8333-333333333333' },
    });
    const found = await store.findActiveByHash('hash-1', now);
    expect(found?.activeBuilderId).toBe('33333333-3333-4333-8333-333333333333');
    expect(found?.viewAs).toEqual({
      builderId: '33333333-3333-4333-8333-333333333333',
    });
    // Clearing state works too (view-as exit path).
    await store.updateState('hash-1', {
      activeBuilderId: null,
      viewAs: null,
    });
    const cleared = await store.findActiveByHash('hash-1', now);
    expect(cleared?.activeBuilderId).toBeNull();
    expect(cleared?.viewAs).toBeNull();
  });

  it('admin session store round-trips the id_token (logout id_token_hint)', async () => {
    const store = createDrizzleAdminSessionStore({ db: testDb.db });
    const now = new Date();
    await store.insert({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'admin@example.com',
      sessionTokenHash: 'hash-idtoken',
      idToken: 'stub-id-token',
      expiresAt: new Date(now.getTime() + 3600_000),
    });
    const found = await store.findActiveByHash('hash-idtoken', now);
    expect(found?.idToken).toBe('stub-id-token');
    // Legacy sessions (minted before the column existed) read back null.
    const legacy = await store.findActiveByHash('hash-1', now);
    expect(legacy?.idToken).toBeNull();
  });
});

describe('auth/04 tenant-scoped lead access (PGlite)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('findByIdAndBuilderId and updateStatusForBuilder never touch another builder\'s rows', async () => {
    const builderA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const builderB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const estimateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await testDb.db.execute(
      `insert into builders (id, tenant_key, business_name, display_name) values
       ('${builderA}', 'builder-a', 'Builder A', 'Builder A'),
       ('${builderB}', 'builder-b', 'Builder B', 'Builder B')`,
    );
    // leads.estimate_id references estimates(id) — insert a minimal estimate.
    await testDb.db.execute(
      `insert into estimates (id, address_key, inputs, figures, rows, cost_data_version) values
       ('${estimateId}', 'addr-1', '{}', '{}', '[]', 'test')`,
    );
    const store = createDrizzleLeadStore({ db: testDb.db });
    const leadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await store.insert({
      id: leadId,
      estimateId,
      addressKey: 'addr-1',
      email: 'lead@example.com',
      name: 'Test Lead',
      timeline: 'soon',
      marketingConsent: false,
      consentTs: new Date(),
      source: 'api',
      builderId: builderA,
    });

    // Cross-tenant read returns nothing — the row is never pulled.
    const crossRead = await store.findByIdAndBuilderId({
      id: leadId,
      builderId: builderB,
    });
    expect(crossRead).toBeNull();

    // Cross-tenant write updates zero rows — the status is unchanged.
    const crossWrite = await store.updateStatusForBuilder({
      id: leadId,
      builderId: builderB,
      status: 'contacted',
    });
    expect(crossWrite).toBeNull();
    const untouched = await store.findById(leadId);
    expect(untouched?.status).toBe('new');

    // The owning builder reads and writes normally.
    const ownRead = await store.findByIdAndBuilderId({
      id: leadId,
      builderId: builderA,
    });
    expect(ownRead?.id).toBe(leadId);
    const ownWrite = await store.updateStatusForBuilder({
      id: leadId,
      builderId: builderA,
      status: 'contacted',
    });
    expect(ownWrite?.status).toBe('contacted');

    // existsById is a boolean probe — no row data.
    expect(await store.existsById(leadId)).toBe(true);
    expect(await store.existsById('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).toBe(
      false,
    );
  });
});
