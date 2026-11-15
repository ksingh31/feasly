/**
 * #728 audit viewer / finance exports / builder activity — Drizzle store +
 * service against real migrations (PGlite).
 *
 * Covers: merged newest-first keyset pagination across admin_audit_log and
 * billing_events (including rows that share a millisecond), filters,
 * impersonation-only, builder scoping (team vs self, staff internals
 * hidden), cross-tenant export isolation, refunds, CSV totals == summary
 * to the cent, and the audit row every export writes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVOICE_EXPORT_COLUMNS } from '@feasly/contracts';
import {
  attributionEvents,
  billingEvents,
  builders,
  commissionInvoices,
  estimates,
  leads,
  tenants,
} from '../src/db/schema';
import { createDrizzleAuditFinanceStore } from '../src/services/audit-finance.store';
import {
  createAuditFinanceService,
  type AuditFinanceService,
} from '../src/services/audit-finance.service';
import { createDrizzleAdminAuditStore } from '../src/services/admin-audit.store';
import { createTestDb, type TestDb } from './pglite-db';

const ELITE = { tenantKey: 'elite-craft', builderId: randomUUID() };
const OTHER = { tenantKey: 'other-homes', builderId: randomUUID() };
const NOV = (day: number, hh = 12) => new Date(Date.UTC(2026, 10, day, hh, 0, 0));

async function seedTenant(db: TestDb, t: { tenantKey: string; builderId: string }, name: string) {
  await db.db.insert(tenants).values({
    tenantKey: t.tenantKey,
    businessName: name,
    displayName: name,
    accentColor: '#B08D57',
    allowedOrigins: [],
  });
  await db.db.insert(builders).values({
    id: t.builderId,
    tenantKey: t.tenantKey,
    businessName: name,
    displayName: name,
  });
}

let invoiceSeq = 0;
async function seedInvoice(
  db: TestDb,
  tenantKey: string,
  over: Partial<typeof commissionInvoices.$inferInsert> = {},
): Promise<string> {
  const estimateId = randomUUID();
  const leadId = randomUUID();
  await db.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: 'calgary-1-test-st-nw',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  await db.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: 'calgary-1-test-st-nw',
    email: 'owner@example.com',
    name: 'Owner',
    timeline: '6-12 months',
    consentTs: NOV(1),
  });
  const attributionId = randomUUID();
  await db.db.insert(attributionEvents).values({
    id: attributionId,
    leadId,
    tenantKey,
    introducedAt: NOV(1),
  });
  const id = randomUUID();
  invoiceSeq += 1;
  await db.db.insert(commissionInvoices).values({
    id,
    tenantKey,
    attributionId,
    leadId,
    contractValueCents: 50_000_000,
    commissionCents: 500_000,
    taxCents: 25_000,
    totalCents: 525_000,
    taxRatePercent: 5,
    commissionRatePercent: 1,
    invoiceNumber: `INV-${String(invoiceSeq).padStart(4, '0')}`,
    status: 'in_review',
    createdAt: NOV(10),
    ...over,
  });
  return id;
}

describe('audit-finance store (PGlite)', () => {
  let testDb: TestDb;
  let service: AuditFinanceService;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    testDb = await createTestDb();
    service = createAuditFinanceService({
      store: createDrizzleAuditFinanceStore({ db: testDb.db }),
      audit: createDrizzleAdminAuditStore({ db: testDb.db }),
      config: {
        exportMaxRows: 100,
        maxRangeDays: 366,
        defaultCommissionRate: 0.01,
        currency: 'CAD',
      },
      now: () => NOV(15),
    });
    await seedTenant(testDb, ELITE, 'Elite Craft Builders Ltd');
    await seedTenant(testDb, OTHER, 'Other Homes, Inc.');

    // Invoices (Nov 2026): paid, unpaid, void-unpaid, refunded (paid→void).
    ids.paid = await seedInvoice(testDb, ELITE.tenantKey, {
      status: 'paid',
      paidAt: NOV(12),
      stripePaymentIntentId: 'pi_paid_1',
    });
    ids.unpaid = await seedInvoice(testDb, ELITE.tenantKey, {
      commissionCents: 123_456,
      taxCents: 6_173,
      totalCents: 129_629,
    });
    ids.voided = await seedInvoice(testDb, ELITE.tenantKey, { status: 'void' });
    ids.refunded = await seedInvoice(testDb, OTHER.tenantKey, {
      status: 'void',
      paidAt: NOV(11),
      commissionRateOverride: 1.5,
      paymentMethod: 'card',
    });
    // Outside the period.
    ids.october = await seedInvoice(testDb, ELITE.tenantKey, { createdAt: new Date(Date.UTC(2026, 9, 31, 23)) });

    // Audit trail. Two admin rows share one millisecond (µs apart).
    await testDb.exec(`
      INSERT INTO admin_audit_log (id, actor_email, action, detail, created_at) VALUES
      ('00000000-0000-4000-8000-000000000001', 'karan@feasly.test', 'admin_builder_commission_rate_changed',
        'builderId=${ELITE.builderId} tenantKey=${ELITE.tenantKey} from=1 to=1.5', '2026-11-05T10:00:00.123400Z'),
      ('00000000-0000-4000-8000-000000000002', 'karan@feasly.test', 'admin_builder_updated',
        'builderId=${ELITE.builderId} tenantKey=${ELITE.tenantKey}', '2026-11-05T10:00:00.123456Z'),
      ('00000000-0000-4000-8000-000000000003', 'karan@feasly.test', 'view_as.activated',
        'target=builder:${ELITE.builderId}', '2026-11-06T10:00:00Z'),
      ('00000000-0000-4000-8000-000000000004', 'owner@elite.test', 'user.invited',
        'email=crew@elite.test role=builder_member', '2026-11-07T10:00:00Z'),
      ('00000000-0000-4000-8000-000000000005', 'crew@elite.test', 'builder_leads_status_changed',
        'leadId=${randomUUID()} oldStatus=new newStatus=contacted tenantKey=${ELITE.tenantKey}', '2026-11-08T10:00:00Z'),
      ('00000000-0000-4000-8000-000000000006', 'crew@elite.test', 'authz.denied',
        'route=x tenantKey=${ELITE.tenantKey}', '2026-11-08T11:00:00Z'),
      ('00000000-0000-4000-8000-000000000007', 'other@other.test', 'builder_leads_status_changed',
        'leadId=${randomUUID()} oldStatus=new newStatus=won tenantKey=${OTHER.tenantKey}', '2026-11-08T12:00:00Z'),
      ('00000000-0000-4000-8000-000000000008', 'x@elite.test', 'builder_leads_status_changed',
        'tenantKey=${ELITE.tenantKey}-annex', '2026-11-08T13:00:00Z')
    `);
    await testDb.db.insert(billingEvents).values([
      {
        id: randomUUID(),
        tenantKey: OTHER.tenantKey,
        eventType: 'invoice.status_changed',
        entityType: 'commission_invoice',
        entityId: ids.refunded!,
        payload: { status: 'void', from: 'paid', creditNote: 'stripe_refund', refundId: 're_1' },
        createdAt: NOV(13),
      },
      {
        id: randomUUID(),
        tenantKey: ELITE.tenantKey,
        eventType: 'invoice.paid_manually',
        entityType: 'commission_invoice',
        entityId: ids.paid!,
        payload: { adminEmail: 'karan@feasly.test', method: 'cheque' },
        createdAt: NOV(12),
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('pages the merged trail newest first without skipping or repeating rows', async () => {
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await service.listAudit({ limit: '3', ...(cursor ? { cursor } : {}) });
      all.push(...page.items.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);
    const single = await service.listAudit({ limit: '100' });
    expect(single.items.map((e) => e.id)).toEqual(all);
    expect(single.nextCursor).toBeNull();
    // Same-millisecond rows keep microsecond order.
    const i1 = all.indexOf('admin:00000000-0000-4000-8000-000000000001');
    const i2 = all.indexOf('admin:00000000-0000-4000-8000-000000000002');
    expect(i2).toBeLessThan(i1);
  });

  it('shows a rate change with actor, time, before/after and an entity link', async () => {
    const { items } = await service.listAudit({ action: 'admin_builder_commission_rate_changed' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      actorEmail: 'karan@feasly.test',
      occurredAt: '2026-11-05T10:00:00.123Z',
      entityType: 'builder',
      entityId: ELITE.builderId,
      tenantKey: ELITE.tenantKey,
      payload: { from: '1', to: '1.5' },
      impersonation: false,
    });
  });

  it('filters by actor across both sources, by date and by impersonation', async () => {
    const byActor = await service.listAudit({ actor: 'KARAN@feasly.test' });
    expect(byActor.items.map((e) => e.action)).toEqual([
      'invoice.paid_manually',
      'view_as.activated',
      'admin_builder_updated',
      'admin_builder_commission_rate_changed',
    ]);
    const imp = await service.listAudit({ impersonation: 'true' });
    expect(imp.items.map((e) => e.action)).toEqual(['view_as.activated']);
    expect(imp.items[0]!.impersonation).toBe(true);
    const ranged = await service.listAudit({ from: '2026-11-12', to: '2026-11-13' });
    expect(ranged.items.map((e) => e.action)).toEqual(['invoice.paid_manually']);
    const refund = await service.listAudit({ entityId: ids.refunded });
    expect(refund.items[0]).toMatchObject({ entityType: 'invoice', source: 'billing' });
  });

  it('builder team activity: own tenant only, staff internals hidden, staff shown as Feasly', async () => {
    const res = await service.builderActivity(
      {},
      { email: 'owner@elite.test', tenantKey: ELITE.tenantKey, builderId: ELITE.builderId, team: true },
    );
    expect(res.scope).toBe('team');
    const actions = res.items.map((e) => e.action);
    expect(actions).toEqual([
      'invoice.paid_manually',
      'builder_leads_status_changed',
      'view_as.activated',
      'admin_builder_updated',
      'admin_builder_commission_rate_changed',
    ]);
    expect(actions).not.toContain('authz.denied');
    const staffRow = res.items.find((e) => e.action === 'admin_builder_updated');
    expect(staffRow!.actorEmail).toBeNull();
  });

  it('builder member activity: only their own actions', async () => {
    const res = await service.builderActivity(
      {},
      { email: 'crew@elite.test', tenantKey: ELITE.tenantKey, builderId: ELITE.builderId, team: false },
    );
    expect(res.scope).toBe('self');
    expect(res.items.map((e) => e.action)).toEqual(['builder_leads_status_changed']);
  });

  it('builder export contains only that builder’s invoices (cross-tenant)', async () => {
    const { csv, filename } = await service.exportInvoices(
      { tenantKey: OTHER.tenantKey },
      { kind: 'builder', email: 'owner@elite.test', tenantKey: ELITE.tenantKey, builderId: ELITE.builderId },
    );
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(INVOICE_EXPORT_COLUMNS.join(','));
    expect(lines).toHaveLength(4); // header + paid, unpaid, void (October excluded)
    expect(csv).not.toContain(OTHER.tenantKey);
    expect(filename).toBe('invoices-elite-craft-2026-11-01_2026-11-30.csv');
  });

  it('admin CSV totals match the summary to the cent, refunds included', async () => {
    const { csv } = await service.exportInvoices({ from: '2026-11-01', to: '2026-12-01' }, {
      kind: 'staff',
      email: 'karan@feasly.test',
    });
    const [header, ...rows] = csv.trim().split('\r\n');
    const cols = header!.split(',');
    const parsed = rows.map((line) => {
      // Builder names may be quoted ("Other Homes, Inc.").
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, ''));
      return Object.fromEntries(cols.map((c, i) => [c, cells[i]!.replace(/^"|"$/g, '')]));
    });
    expect(parsed).toHaveLength(4);
    const refundedRow = parsed.find((r) => r['tenant_key'] === OTHER.tenantKey)!;
    expect(refundedRow).toMatchObject({
      builder: 'Other Homes, Inc.',
      commission_rate_percent: '1.5',
      total: '5250.00',
      refunded: '5250.00',
      status: 'void',
    });
    const paidRow = parsed.find((r) => r['stripe_payment_intent_id'] === 'pi_paid_1')!;
    expect(paidRow['paid_at']).toBe('2026-11-12T12:00:00.000Z');

    const summary = await service.financeSummary({ from: '2026-11-01', to: '2026-12-01' });
    const cents = (v: string) => Math.round(Number(v) * 100);
    const billable = parsed.filter((r) => !(r['status'] === 'void' && r['paid_at'] === ''));
    expect(summary.invoiceCount).toBe(billable.length);
    expect(summary.invoicedCents).toBe(billable.reduce((s, r) => s + cents(r['total']!), 0));
    expect(summary.taxCents).toBe(billable.reduce((s, r) => s + cents(r['tax']!), 0));
    expect(summary.refundedCents).toBe(parsed.reduce((s, r) => s + cents(r['refunded']!), 0));
    expect(summary).toMatchObject({
      invoicedCents: 525_000 + 129_629 + 525_000,
      collectedCents: 525_000 + 525_000,
      outstandingCents: 129_629,
      refundedCents: 525_000,
      taxCents: 25_000 + 6_173 + 25_000,
      currency: 'CAD',
    });
    expect(summary.byBuilder.map((b) => b.tenantKey)).toEqual([ELITE.tenantKey, OTHER.tenantKey]);
  });

  it('every export writes an audit row', async () => {
    const rows = await testDb.rows<{ action: string; detail: string }>(
      `SELECT action, detail FROM admin_audit_log WHERE action = 'finance.invoices_exported' ORDER BY created_at`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.detail.includes(`tenantKey=${ELITE.tenantKey}`))).toBe(true);
    expect(rows.some((r) => r.detail.startsWith('scope=all'))).toBe(true);
    // Admin audit rows for the builder's export appear in the builder's activity.
    const activity = await service.builderActivity(
      {},
      { email: 'owner@elite.test', tenantKey: ELITE.tenantKey, builderId: ELITE.builderId, team: true },
    );
    expect(activity.items[0]!.action).toBe('finance.invoices_exported');
  });
});
