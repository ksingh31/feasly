/**
 * Lead reassignment rules (#721), against PGlite with the real migrations.
 *
 * Covers: first assignment, A→B with no invoice (attribution closed and
 * reopened, status reset, history row, audit rows for both tenants),
 * unassign (A→null), every blocking invoice status (409 LEAD_HAS_INVOICE
 * naming the invoice, nothing moved), a void invoice not blocking, a
 * recorded contract without an invoice blocking, no-op reassignment, 404s,
 * and the "Reassigned by Feasly" list for the old builder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  attributionEvents,
  commissionInvoices,
  estimates,
  leadReassignments,
  leadStatusHistory,
  leads,
} from '../src/db/schema';
import { ErrorCodes } from '../src/middleware/errors';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import { createBuilderService } from '../src/services/builder.service';
import {
  createLeadAssignmentService,
  type LeadAssignmentService,
} from '../src/services/lead-assignment.service';
import { createTestDb, type TestDb } from './pglite-db';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const ADMIN = 'admin@example.com';

let testDb: TestDb;
let auditEntries: { action: string; detail?: string }[];
let service: LeadAssignmentService;
let builderA: { id: string; tenantKey: string };
let builderB: { id: string; tenantKey: string };
let invoiceSeq = 0;

const audit = {
  log: async (entry: { action: string; detail?: string }) => {
    auditEntries.push(entry);
  },
  append: async () => {
    throw new Error('not used');
  },
  recent: async () => [],
} as unknown as AdminAuditStore;

async function createBuilder(tenantKey: string) {
  const builders = createBuilderService({ db: testDb.db, audit });
  const created = await builders.createBuilder(
    { tenantKey, businessName: `${tenantKey} Ltd.`, displayName: tenantKey },
    ADMIN,
  );
  return { id: created.id, tenantKey: created.tenantKey };
}

async function seedLead(opts: {
  builder: { id: string; tenantKey: string } | null;
  status?: string;
}): Promise<string> {
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: '123-test-st-calgary',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  const leadId = randomUUID();
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: '123-test-st-calgary',
    email: 'homeowner@example.com',
    name: `Homeowner ${leadId.slice(0, 4)}`,
    timeline: '6-12 months',
    consentTs: new Date('2026-03-01T09:00:00.000Z'),
    builderId: opts.builder?.id ?? null,
    tenantKey: opts.builder?.tenantKey ?? null,
    status: opts.status ?? 'new',
  });
  return leadId;
}

async function introduce(leadId: string, tenantKey: string, status = 'introduced') {
  const id = randomUUID();
  await testDb.db.insert(attributionEvents).values({
    id,
    leadId,
    tenantKey,
    introducedAt: new Date('2026-10-01T00:00:00.000Z'),
    status,
  });
  return id;
}

async function seedInvoice(leadId: string, tenantKey: string, status: string) {
  const attributionId = await introduce(leadId, tenantKey, 'attributed');
  const invoiceNumber = `INV-T721-${String(++invoiceSeq).padStart(4, '0')}`;
  await testDb.db.insert(commissionInvoices).values({
    id: randomUUID(),
    tenantKey,
    attributionId,
    leadId,
    contractValueCents: 50_000_000,
    commissionCents: 500_000,
    currency: 'CAD',
    status,
    invoiceNumber,
  });
  return invoiceNumber;
}

async function leadRow(leadId: string) {
  const row = await testDb.db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  return row!;
}

async function attributionsFor(leadId: string) {
  return testDb.db
    .select()
    .from(attributionEvents)
    .where(eq(attributionEvents.leadId, leadId));
}

beforeAll(async () => {
  testDb = await createTestDb();
  auditEntries = [];
  builderA = await createBuilder('builder-a-721');
  builderB = await createBuilder('builder-b-721');
}, 60_000);

afterAll(async () => {
  await testDb.close();
});

beforeEach(() => {
  auditEntries = [];
  service = createLeadAssignmentService({ db: testDb.db, audit, now: () => new Date(NOW) });
});

describe('lead assignment (#721)', () => {
  it('first assignment sets builder + tenant key and opens no attribution', async () => {
    const leadId = await seedLead({ builder: null });
    const result = await service.assignLead(leadId, builderA.id, ADMIN);
    expect(result).toEqual({
      ok: true,
      changed: true,
      fromBuilderId: null,
      toBuilderId: builderA.id,
    });
    const row = await leadRow(leadId);
    expect(row.builderId).toBe(builderA.id);
    expect(row.tenantKey).toBe(builderA.tenantKey);
    expect(await attributionsFor(leadId)).toHaveLength(0);
    expect(auditEntries.map((e) => e.action)).toEqual(['admin_lead_builder_assigned']);
  });

  it('A→B with no invoice closes A, opens B dated now, resets status, records the move', async () => {
    const leadId = await seedLead({ builder: builderA, status: 'contacted' });
    const oldIntro = await introduce(leadId, builderA.tenantKey);

    const result = await service.assignLead(leadId, builderB.id, ADMIN);
    expect(result).toMatchObject({ changed: true, fromBuilderId: builderA.id, toBuilderId: builderB.id });

    const row = await leadRow(leadId);
    expect(row.builderId).toBe(builderB.id);
    expect(row.tenantKey).toBe(builderB.tenantKey);
    expect(row.status).toBe('new');

    const attributions = await attributionsFor(leadId);
    const closed = attributions.find((a) => a.id === oldIntro);
    expect(closed?.status).toBe('reassigned');
    const opened = attributions.filter(
      (a) => a.tenantKey === builderB.tenantKey && a.status === 'introduced',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.introducedAt.toISOString()).toBe(NOW.toISOString());

    const history = await testDb.db
      .select()
      .from(leadStatusHistory)
      .where(eq(leadStatusHistory.leadId, leadId));
    expect(history).toEqual([
      expect.objectContaining({ oldStatus: 'contacted', newStatus: 'new', changedBy: ADMIN }),
    ]);

    const moves = await service.listForLead(leadId);
    expect(moves).toEqual([
      { fromBuilderId: builderA.id, toBuilderId: builderB.id, actorEmail: ADMIN, reassignedAt: NOW },
    ]);

    // One audit row per tenant.
    expect(auditEntries).toHaveLength(2);
    expect(auditEntries[0]).toMatchObject({ action: 'admin_lead_reassigned_away' });
    expect(auditEntries[0]!.detail).toContain(`tenantKey=${builderA.tenantKey}`);
    expect(auditEntries[1]).toMatchObject({ action: 'admin_lead_builder_assigned' });
    expect(auditEntries[1]!.detail).toContain(`tenantKey=${builderB.tenantKey}`);
    // No homeowner PII in audit details.
    for (const entry of auditEntries) {
      expect(entry.detail).not.toContain('homeowner@example.com');
    }
  });

  it('A→B works when A never had an introduction', async () => {
    const leadId = await seedLead({ builder: builderA });
    await service.assignLead(leadId, builderB.id, ADMIN);
    const attributions = await attributionsFor(leadId);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({ tenantKey: builderB.tenantKey, status: 'introduced' });
    // Status was already 'new': no history row.
    const history = await testDb.db
      .select()
      .from(leadStatusHistory)
      .where(eq(leadStatusHistory.leadId, leadId));
    expect(history).toHaveLength(0);
  });

  it('unassigning follows the same rules: A closed, no new introduction', async () => {
    const leadId = await seedLead({ builder: builderA, status: 'quoted' });
    const oldIntro = await introduce(leadId, builderA.tenantKey);

    const result = await service.assignLead(leadId, null, ADMIN);
    expect(result).toMatchObject({ changed: true, fromBuilderId: builderA.id, toBuilderId: null });

    const row = await leadRow(leadId);
    expect(row.builderId).toBeNull();
    expect(row.tenantKey).toBeNull();
    expect(row.status).toBe('new');
    const attributions = await attributionsFor(leadId);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({ id: oldIntro, status: 'reassigned' });
    expect(auditEntries.map((e) => e.action)).toEqual([
      'admin_lead_reassigned_away',
      'admin_lead_builder_unassigned',
    ]);
  });

  it.each(['draft', 'in_review', 'failed', 'finalized', 'paid', 'disputed'])(
    'a %s invoice blocks the move with 409 naming the invoice, and nothing changes',
    async (status) => {
      const leadId = await seedLead({ builder: builderA, status: 'won' });
      const openIntro = await introduce(leadId, builderA.tenantKey);
      const invoiceNumber = await seedInvoice(leadId, builderA.tenantKey, status);

      for (const target of [builderB.id, null]) {
        const error = await service.assignLead(leadId, target, ADMIN).catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 409, code: ErrorCodes.LEAD_HAS_INVOICE });
        expect((error as Error).message).toContain(invoiceNumber);
        const expected =
          status === 'paid' || status === 'finalized'
            ? 'Refund'
            : status === 'disputed'
              ? 'dispute'
              : 'Void the invoice';
        expect((error as Error).message).toContain(expected);
      }

      const row = await leadRow(leadId);
      expect(row.builderId).toBe(builderA.id);
      expect(row.status).toBe('won');
      const intro = (await attributionsFor(leadId)).find((a) => a.id === openIntro);
      expect(intro?.status).toBe('introduced');
      expect(await service.listForLead(leadId)).toHaveLength(0);
      expect(auditEntries).toHaveLength(0);
    },
  );

  it('a void invoice does not block the move', async () => {
    const leadId = await seedLead({ builder: builderA, status: 'won' });
    await seedInvoice(leadId, builderA.tenantKey, 'void');
    await service.assignLead(leadId, builderB.id, ADMIN);
    expect((await leadRow(leadId)).builderId).toBe(builderB.id);
  });

  it('a recorded contract with no invoice blocks the move with 409', async () => {
    const leadId = await seedLead({ builder: builderA, status: 'won' });
    await introduce(leadId, builderA.tenantKey, 'attributed');
    await expect(service.assignLead(leadId, builderB.id, ADMIN)).rejects.toMatchObject({
      status: 409,
      code: ErrorCodes.CONFLICT,
    });
    expect((await leadRow(leadId)).builderId).toBe(builderA.id);
  });

  it('assigning to the current builder is a no-op', async () => {
    const leadId = await seedLead({ builder: builderA, status: 'contacted' });
    const intro = await introduce(leadId, builderA.tenantKey);
    const result = await service.assignLead(leadId, builderA.id, ADMIN);
    expect(result).toMatchObject({ changed: false });
    expect((await leadRow(leadId)).status).toBe('contacted');
    expect((await attributionsFor(leadId)).find((a) => a.id === intro)?.status).toBe('introduced');
    expect(auditEntries).toHaveLength(0);
  });

  it('keeps an already-open introduction for the new builder', async () => {
    const leadId = await seedLead({ builder: builderA });
    await introduce(leadId, builderB.tenantKey);
    await service.assignLead(leadId, builderB.id, ADMIN);
    const open = (await attributionsFor(leadId)).filter(
      (a) => a.tenantKey === builderB.tenantKey && a.status === 'introduced',
    );
    expect(open).toHaveLength(1);
  });

  it('404s for an unknown lead or builder', async () => {
    await expect(service.assignLead(randomUUID(), builderA.id, ADMIN)).rejects.toMatchObject({
      status: 404,
    });
    const leadId = await seedLead({ builder: builderA });
    await expect(service.assignLead(leadId, randomUUID(), ADMIN)).rejects.toMatchObject({
      status: 404,
    });
    expect((await leadRow(leadId)).builderId).toBe(builderA.id);
  });

  it('lists leads moved away from a builder until they come back', async () => {
    const owner = await createBuilder('builder-c-721');
    const leadId = await seedLead({ builder: owner });
    expect(await service.listReassignedAway(owner.id)).toEqual([]);

    await service.assignLead(leadId, builderB.id, ADMIN);
    const name = (await leadRow(leadId)).name;
    expect(await service.listReassignedAway(owner.id)).toEqual([
      { id: leadId, name, reassignedAt: NOW.toISOString() },
    ]);
    // The new builder has nothing "reassigned away".
    const forB = await service.listReassignedAway(builderB.id);
    expect(forB.find((r) => r.id === leadId)).toBeUndefined();

    // Moved back to the original builder → a normal lead again.
    await service.assignLead(leadId, owner.id, ADMIN);
    expect(await service.listReassignedAway(owner.id)).toEqual([]);
    // ...and now B sees it as reassigned away, once.
    const forBAfter = (await service.listReassignedAway(builderB.id)).filter(
      (r) => r.id === leadId,
    );
    expect(forBAfter).toHaveLength(1);

    const rows = await testDb.db
      .select()
      .from(leadReassignments)
      .where(and(eq(leadReassignments.leadId, leadId)));
    expect(rows).toHaveLength(2);
  });
});
