/**
 * Admin global search — Drizzle store against real migrations (PGlite).
 *
 * Covers every AC-1 field end to end through the service: lead name /
 * email / address, invoice number, builder name + slug, user name / email.
 * Also checks LIKE metacharacters are matched literally and that hidden
 * lead rows (sandbox, quarantined, discarded) never surface.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attributionEvents,
  builders,
  commissionInvoices,
  estimates,
  leads,
  tenants,
  users,
} from '../src/db/schema';
import { createDrizzleAdminSearchStore } from '../src/services/admin-search.store';
import {
  createAdminSearchService,
  type AdminSearchService,
} from '../src/services/admin-search.service';
import { ROLE_PERMISSIONS } from '../src/auth/permissions';
import { createTestDb, type TestDb } from './pglite-db';

const ADMIN = ROLE_PERMISSIONS.admin;

const ids = {
  lead: randomUUID(),
  hiddenSandbox: randomUUID(),
  hiddenQuarantined: randomUUID(),
  hiddenDiscarded: randomUUID(),
  invoice: randomUUID(),
  builder: randomUUID(),
  user: randomUUID(),
  percentUser: randomUUID(),
};

async function seedLead(
  testDb: TestDb,
  id: string,
  over: Partial<typeof leads.$inferInsert> = {},
): Promise<void> {
  const estimateId = randomUUID();
  const addressKey = over.addressKey ?? 'calgary-123-fake-st-nw';
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey,
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  await testDb.db.insert(leads).values({
    id,
    estimateId,
    addressKey,
    email: 'ava.homeowner@example.com',
    name: 'Ava Homeowner',
    timeline: '6-12 months',
    consentTs: new Date('2026-03-01T09:00:00.000Z'),
    ...over,
  });
}

describe('admin search store (PGlite)', () => {
  let testDb: TestDb;
  let service: AdminSearchService;

  beforeAll(async () => {
    testDb = await createTestDb();
    service = createAdminSearchService({
      store: createDrizzleAdminSearchStore({ db: testDb.db }),
      config: { maxHitsPerKind: 5 },
    });

    await seedLead(testDb, ids.lead);
    await seedLead(testDb, ids.hiddenSandbox, { name: 'Ava Sandbox', sandbox: true });
    await seedLead(testDb, ids.hiddenQuarantined, { name: 'Ava Spam', quarantined: true });
    await seedLead(testDb, ids.hiddenDiscarded, {
      name: 'Ava Discarded',
      quarantined: true,
      discarded: true,
    });

    await testDb.db.insert(tenants).values({
      tenantKey: 'elite-craft',
      businessName: 'Elite Craft Builders Ltd',
      displayName: 'Elite Craft',
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
    });
    await testDb.db.insert(builders).values({
      id: ids.builder,
      tenantKey: 'elite-craft',
      businessName: 'Elite Craft Builders Ltd',
      displayName: 'Elite Craft',
    });
    const attributionId = randomUUID();
    await testDb.db.insert(attributionEvents).values({
      id: attributionId,
      leadId: ids.lead,
      tenantKey: 'elite-craft',
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    await testDb.db.insert(commissionInvoices).values({
      id: ids.invoice,
      tenantKey: 'elite-craft',
      attributionId,
      leadId: ids.lead,
      contractValueCents: 50_000_000,
      commissionCents: 500_000,
      invoiceNumber: 'FEAS-2026-0105',
      status: 'in_review',
    });

    await testDb.db.insert(users).values([
      { id: ids.user, email: 'morgan.ops@feasly.test', name: 'Morgan Ops', status: 'active' },
      { id: ids.percentUser, email: 'pct@feasly.test', name: '100% Real', status: 'active' },
    ]);
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  const kindsAndIds = (hits: readonly { kind: string; id: string }[]) =>
    hits.map((h) => `${h.kind}:${h.id}`);

  it('finds a lead by name, case-insensitively', async () => {
    const hits = await service.search('ava home', ADMIN);
    expect(kindsAndIds(hits)).toEqual([`lead:${ids.lead}`]);
    expect(hits[0]).toEqual({
      kind: 'lead',
      id: ids.lead,
      label: 'Ava Homeowner',
      sublabel: 'ava.homeowner@example.com · calgary-123-fake-st-nw',
    });
  });

  it('finds a lead by email', async () => {
    expect(kindsAndIds(await service.search('AVA.HOMEOWNER@', ADMIN))).toEqual([
      `lead:${ids.lead}`,
    ]);
  });

  it('finds a lead by a natural-language address against a slug address key', async () => {
    expect(kindsAndIds(await service.search('123 Fake St', ADMIN))).toEqual([
      `lead:${ids.lead}`,
    ]);
  });

  it('never surfaces sandbox, quarantined, or discarded leads', async () => {
    const hits = await service.search('Ava', ADMIN);
    expect(hits.map((h) => h.id)).toEqual([ids.lead]);
  });

  it('finds an invoice by (partial) invoice number', async () => {
    const hits = await service.search('feas-2026-01', ADMIN);
    expect(hits).toEqual([
      {
        kind: 'invoice',
        id: ids.invoice,
        label: 'FEAS-2026-0105',
        sublabel: 'elite-craft · in_review',
      },
    ]);
  });

  it('finds a builder by name and by slug', async () => {
    const byName = await service.search('elite craft', ADMIN);
    expect(byName).toContainEqual({
      kind: 'builder',
      id: ids.builder,
      label: 'Elite Craft',
      sublabel: 'Elite Craft Builders Ltd · elite-craft',
    });
    const bySlug = await service.search('elite-cr', ADMIN);
    expect(kindsAndIds(bySlug)).toContain(`builder:${ids.builder}`);
  });

  it('finds a user by name and by email', async () => {
    expect(kindsAndIds(await service.search('morgan', ADMIN))).toEqual([
      `user:${ids.user}`,
    ]);
    expect(kindsAndIds(await service.search('ops@feasly', ADMIN))).toEqual([
      `user:${ids.user}`,
    ]);
  });

  it('matches LIKE metacharacters literally', async () => {
    // "%" must not act as a wildcard (which would match every user).
    expect(kindsAndIds(await service.search('0%', ADMIN))).toEqual([
      `user:${ids.percentUser}`,
    ]);
    expect(await service.search('_', ADMIN)).toEqual([]);
  });

  it('respects the per-kind hit limit', async () => {
    const limited = createAdminSearchService({
      store: createDrizzleAdminSearchStore({ db: testDb.db }),
      config: { maxHitsPerKind: 1 },
    });
    // "feasly.test" matches both users; only one comes back.
    const hits = await limited.search('feasly.test', ADMIN);
    expect(hits.filter((h) => h.kind === 'user')).toHaveLength(1);
  });

  it('gives a viewer every kind except users (no users:manage)', async () => {
    const viewerHits = await service.search('e', ROLE_PERMISSIONS.viewer);
    const kinds = new Set(viewerHits.map((h) => h.kind));
    expect(kinds).toEqual(new Set(['lead', 'invoice', 'builder']));
    const adminKinds = new Set((await service.search('e', ADMIN)).map((h) => h.kind));
    expect(adminKinds).toEqual(new Set(['lead', 'invoice', 'builder', 'user']));
  });
});
