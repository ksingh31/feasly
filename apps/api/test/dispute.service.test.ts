/**
 * Dispute service tests (billing/01 follow-on, was OPS-009).
 *
 * Runs against PGlite with the real migration SQL — so this also pins
 * migration 0031 (`billing_disputes` materializes) and its idempotency
 * (re-applying the SQL is a no-op). The commission engine is real; Stripe
 * and email are fakes — no network, no real charges. Covers:
 * - recordOpenedDispute: dispute row + immutable evidence snapshot +
 *   slaDueAt = openedAt + 5 business days (America/Edmonton),
 * - idempotent re-record for the same invoice,
 * - listOpenDisputes: oldest-first, countdown fields, backfills disputed
 *   invoices that have no dispute row,
 * - acceptDispute: disputed → invoice void; paid → Stripe refund (credit
 *   note) then void; both audit-logged,
 * - rejectDispute: invoice back to in_review with a fresh 7-day window,
 *   audit-logged,
 * - scanSlaBreaches: escalates via ops alerts, never auto-resolves, and
 *   never double-escalates.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createDisputeService,
  type DisputeService,
} from '../src/services/billing/dispute.service';
import {
  createCommissionService,
  type CommissionService,
  type CommissionInvoiceRecord,
} from '../src/services/billing/commission.service';
import {
  createBillingAuditService,
  type BillingAuditService,
} from '../src/services/billing/billing-audit.service';
import {
  createAttributionService,
  type AttributionService,
} from '../src/services/billing/attribution.service';
import {
  createEmbedBillingHookService,
  type EmbedBillingHookService,
} from '../src/services/billing/embed-billing-hook.service';
import { createBillingService } from '../src/services/billing/billing.service';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import type { OpsAlertsService } from '../src/services/ops-alerts.service';
import type { BillingConfig } from '../src/config';
import {
  billingDisputes,
  billingEvents,
  commissionInvoices,
  estimates,
  leads,
  tenants,
} from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const COMMISSION_BILLING: BillingConfig = {
  model: 'commission',
  commissionRate: 0.01,
  attributionWindowDays: 365,
  reportingSlaDays: 14,
  flatPlanName: 'Builder Standard',
  flatMonthlyCents: 30_000,
  flatCurrency: 'CAD',
  stripeSecretKey: 'sk_test_fake',
  stripeWebhookSecret: 'whsec_fake',
  stripeFlatPriceId: undefined,
  isProduction: false,
};

// Monday 2026-09-28 10:00 America/Edmonton.
const FIXED_NOW = new Date('2026-09-28T17:00:00.000Z');
// Monday 2026-09-14 10:00 America/Edmonton (10 business days earlier).
const PAST_NOW = new Date('2026-09-14T17:00:00.000Z');

let idCounter = 7000;
function nextId(): string {
  return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
}

/** Fake Stripe: records calls, never touches the network. */
function fakeStripe(): StripeService & { calls: unknown[] } {
  const calls: unknown[] = [];
  const service: StripeService = {
    isConfigured: true,
    testMode: true,
    createCustomer: async () => ({ id: 'cus_test_123' }),
    createSetupIntent: async () => ({
      id: 'seti_test_123',
      clientSecret: 'seti_test_secret',
    }),
    listPaymentMethods: async () => [],
    createOffSessionPaymentIntent: async (input, idempotencyKey) => {
      calls.push({ op: 'createOffSessionPaymentIntent', input, idempotencyKey });
      return { id: 'pi_test_1', status: 'requires_capture' };
    },
    createSubscription: async () => ({ id: 'sub_test_123', status: 'active' }),
    cancelSubscription: async (subscriptionId) => ({ id: subscriptionId }),
    refundPaymentIntent: async (paymentIntentId, idempotencyKey) => {
      calls.push({ op: 'refundPaymentIntent', paymentIntentId, idempotencyKey });
      return { id: 're_test_1', status: 'succeeded' };
    },
    verifyWebhook: () => {
      throw new Error('not used in these tests');
    },
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
    getCustomerId: async () => 'cus_test_123',
  };
  return Object.assign(service, { calls });
}

/** Fake email: records sends, never sends. */
function fakeEmail(): EmailService & { sent: unknown[] } {
  const sent: unknown[] = [];
  const service = {
    sendOpsAlert: async (input: unknown) => {
      sent.push({ op: 'sendOpsAlert', input });
      return { sent: true as const, provider: 'log' as const };
    },
  };
  return Object.assign(service as unknown as EmailService, { sent });
}

/** Fake ops alerts: records failure notifications. */
function fakeOpsAlerts(): OpsAlertsService & {
  failures: { type: string; context: unknown }[];
} {
  const failures: { type: string; context: unknown }[] = [];
  const service: OpsAlertsService = {
    notifyFailure: async (type, context) => {
      failures.push({ type, context });
    },
    notifyRecovered: async () => {},
  };
  return Object.assign(service, { failures });
}

interface Fixtures {
  hook: EmbedBillingHookService;
  commission: CommissionService;
  audit: BillingAuditService;
  disputes: DisputeService;
  stripe: StripeService & { calls: unknown[] };
  opsAlerts: OpsAlertsService & {
    failures: { type: string; context: unknown }[];
  };
}

function newFixtures(
  testDb: TestDb,
  now: Date,
): Fixtures {
  const stripe = fakeStripe();
  const email = fakeEmail();
  const opsAlerts = fakeOpsAlerts();
  const audit = createBillingAuditService({ db: testDb.db, newId: nextId });
  const attribution: AttributionService = createAttributionService({
    db: testDb.db,
    billing: COMMISSION_BILLING,
    now: () => new Date(now),
    newId: nextId,
  });
  const commission = createCommissionService({
    db: testDb.db,
    billing: COMMISSION_BILLING,
    attribution,
    audit,
    stripe,
    email,
    opsInbox: 'ops@example.com',
    now: () => new Date(now),
    newId: nextId,
  });
  const hook = createEmbedBillingHookService({
    billing: COMMISSION_BILLING,
    attribution,
    commission,
    audit,
    now: () => new Date(now),
  });
  const disputes = createDisputeService({
    db: testDb.db,
    audit,
    commission,
    stripe,
    opsAlerts,
    now: () => new Date(now),
    newId: nextId,
  });
  return { hook, commission, audit, disputes, stripe, opsAlerts };
}

async function seedTenant(testDb: TestDb, key: string): Promise<void> {
  await testDb.db.insert(tenants).values({
    tenantKey: key,
    businessName: `${key} Inc`,
    displayName: key,
    accentColor: '#B08D57',
    allowedOrigins: ['https://example.com'],
    stripeCustomerId: 'cus_test_123',
  });
}

async function seedLead(testDb: TestDb): Promise<string> {
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
    name: 'Test Homeowner',
    timeline: '6-12 months',
    consentTs: new Date('2026-03-01T09:00:00.000Z'),
  });
  return leadId;
}

/** Won deal → draft invoice → auto-submitted into review. */
async function seedReviewedInvoice(
  testDb: TestDb,
  f: Fixtures,
  tenantKey: string,
): Promise<CommissionInvoiceRecord> {
  const leadId = await seedLead(testDb);
  const result = await f.hook.recordBillableEvent(tenantKey, 'lead_won', {
    leadId,
    introducedAt: new Date('2026-03-01T10:00:00.000Z'),
    contractValueCents: 50_000_000, // $500,000 excl. land
    contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
  });
  if (!result.billed || !result.invoiceId) {
    throw new Error('expected a billed invoice');
  }
  return f.commission.getById(result.invoiceId);
}

/** Reviewed invoice → disputed by the builder. */
async function seedDisputedInvoice(
  testDb: TestDb,
  f: Fixtures,
  tenantKey: string,
  reason = 'Contract value is wrong — land was included.',
): Promise<CommissionInvoiceRecord> {
  const invoice = await seedReviewedInvoice(testDb, f, tenantKey);
  return f.commission.disputeInvoice(invoice.id, reason);
}

describe('dispute service', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  it('migration 0031 materializes billing_disputes', async () => {
    const rows = await testDb.rows<{ cls: string | null }>(
      `SELECT to_regclass('public.billing_disputes') AS cls`,
    );
    expect(rows[0].cls).toBe('billing_disputes');
  });

  it('migration 0031 is idempotent (re-apply is a no-op)', async () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        'src',
        'db',
        'migrations',
        '0031_billing_disputes.sql',
      ),
      'utf8',
    );
    const before = await testDb.rows<{ cls: string | null }>(
      `SELECT to_regclass('public.billing_disputes') AS cls`,
    );
    // pg.query (what testDb.rows wraps) uses a prepared statement, which
    // rejects multi-command SQL — apply one statement per breakpoint, the
    // same granularity the deploy pipeline runs.
    const statements = sql
      .split(/-->\s*statement-breakpoint/g)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await testDb.rows(statement);
    }
    const after = await testDb.rows<{ cls: string | null }>(
      `SELECT to_regclass('public.billing_disputes') AS cls`,
    );
    expect(before[0].cls).toBe('billing_disputes');
    expect(after[0].cls).toBe('billing_disputes');
  });

  it('recordOpenedDispute snapshots the invoice and sets the 5-business-day SLA', async () => {
    const tenantKey = 'dispute-open-sla';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);

    const dispute = await f.disputes.recordOpenedDispute(invoice);

    expect(dispute.invoiceId).toBe(invoice.id);
    expect(dispute.tenantKey).toBe(tenantKey);
    expect(dispute.status).toBe('open');
    expect(dispute.reason).toBe(
      'Contract value is wrong — land was included.',
    );
    // Opened Monday 2026-09-28 10:00 MDT → due Monday 2026-10-05 10:00 MDT.
    expect(dispute.slaDueAt.toISOString()).toBe('2026-10-05T17:00:00.000Z');
    // Immutable evidence snapshot.
    expect(dispute.evidenceSnapshot.invoiceId).toBe(invoice.id);
    expect(dispute.evidenceSnapshot.contractValueCents).toBe(50_000_000);
    expect(dispute.evidenceSnapshot.commissionCents).toBe(500_000);
    expect(dispute.evidenceSnapshot.status).toBe('disputed');
    expect(dispute.evidenceSnapshot.backfilled).toBeUndefined();

    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.entityId, dispute.id));
    expect(events.map((e) => e.eventType)).toContain('dispute.opened');
  });

  it('recordOpenedDispute is idempotent for the same invoice', async () => {
    const tenantKey = 'dispute-idempotent';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);

    const first = await f.disputes.recordOpenedDispute(invoice);
    const second = await f.disputes.recordOpenedDispute(invoice);

    expect(second.id).toBe(first.id);
    const rows = await testDb.db
      .select()
      .from(billingDisputes)
      .where(eq(billingDisputes.invoiceId, invoice.id));
    expect(rows).toHaveLength(1);
  });

  it('listOpenDisputes returns oldest-first with countdown fields', async () => {
    const tenantKey = 'dispute-ordering';
    await seedTenant(testDb, tenantKey);
    const early = newFixtures(testDb, PAST_NOW);
    const late = newFixtures(testDb, FIXED_NOW);
    const firstInvoice = await seedDisputedInvoice(testDb, early, tenantKey);
    const secondInvoice = await seedDisputedInvoice(testDb, late, tenantKey);
    await early.disputes.recordOpenedDispute(firstInvoice);
    await late.disputes.recordOpenedDispute(secondInvoice);

    const items = await late.disputes.listOpenDisputes();
    const ids = items.map((d) => d.invoiceId);
    const firstIdx = ids.indexOf(firstInvoice.id);
    const secondIdx = ids.indexOf(secondInvoice.id);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(secondIdx);

    const second = items[secondIdx];
    expect(second.businessDaysRemaining).toBe(5);
    expect(second.breached).toBe(false);
    const first = items[firstIdx];
    // Opened 2026-09-14, SLA due 2026-09-21 — breached by 2026-09-28.
    expect(first.breached).toBe(true);
    expect(first.businessDaysRemaining).toBe(-5);
  });

  it('listOpenDisputes backfills disputed invoices with no dispute row', async () => {
    const tenantKey = 'dispute-backfill';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    // Dispute through the commission engine but skip the dispute service —
    // simulates an invoice disputed before this table existed.
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);

    const items = await f.disputes.listOpenDisputes();
    const found = items.find((d) => d.invoiceId === invoice.id);
    expect(found).toBeDefined();
    expect(found?.evidenceSnapshot.backfilled).toBe(true);

    const rows = await testDb.db
      .select()
      .from(billingDisputes)
      .where(eq(billingDisputes.invoiceId, invoice.id));
    expect(rows).toHaveLength(1);
  });

  it('acceptDispute voids a disputed invoice and audit-logs', async () => {
    const tenantKey = 'dispute-accept';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);
    const dispute = await f.disputes.recordOpenedDispute(invoice);

    const resolved = await f.disputes.acceptDispute(dispute.id, {
      adminEmail: 'admin@feasly.test',
      note: 'Builder was right — land included.',
    });

    expect(resolved.status).toBe('accepted');
    expect(resolved.resolvedBy).toBe('admin@feasly.test');
    expect(resolved.resolutionNote).toBe('Builder was right — land included.');
    expect(resolved.resolvedAt).toEqual(FIXED_NOW);

    const updatedInvoice = await f.commission.getById(invoice.id);
    expect(updatedInvoice.status).toBe('void');
    // No refund: the invoice was never paid.
    expect(
      f.stripe.calls.filter((c) => (c as { op: string }).op === 'refundPaymentIntent'),
    ).toHaveLength(0);

    // Evidence snapshot is immutable — still shows the disputed state.
    const detail = await f.disputes.getDisputeDetail(dispute.id);
    expect(detail.evidenceSnapshot.status).toBe('disputed');
    expect(detail.evidenceSnapshot.commissionCents).toBe(500_000);

    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.tenantKey, tenantKey));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('dispute.resolved');
    expect(types).toContain('invoice.status_changed');
  });

  it('acceptDispute on a paid invoice refunds first (credit note)', async () => {
    const tenantKey = 'dispute-accept-paid';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedReviewedInvoice(testDb, f, tenantKey);
    await f.commission.finalizeInvoice(invoice.id);
    const paid = await f.commission.markPaidByPaymentIntent('pi_test_1');
    expect(paid.status).toBe('paid');

    // The dispute row is recorded directly: the normal dispute path
    // requires in_review, but a payment can land first in a race.
    const dispute = await f.disputes.recordOpenedDispute(
      await f.commission.getById(invoice.id),
    );
    const resolved = await f.disputes.acceptDispute(dispute.id, {
      adminEmail: 'admin@feasly.test',
    });

    expect(resolved.status).toBe('accepted');
    const refunds = f.stripe.calls.filter(
      (c) => (c as { op: string }).op === 'refundPaymentIntent',
    );
    expect(refunds).toHaveLength(1);
    expect(
      (refunds[0] as { idempotencyKey: string }).idempotencyKey,
    ).toBe(`feasly:billing_disputes:${dispute.id}:refund`);

    const updatedInvoice = await f.commission.getById(invoice.id);
    expect(updatedInvoice.status).toBe('void');

    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.tenantKey, tenantKey));
    const creditNote = events.find(
      (e) =>
        e.eventType === 'invoice.status_changed' &&
        (e.payload as { creditNote?: string } | null)?.creditNote ===
          'stripe_refund',
    );
    expect(creditNote).toBeDefined();
  });

  it('rejectDispute returns the invoice to review with a fresh 7-day window', async () => {
    const tenantKey = 'dispute-reject';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);
    const dispute = await f.disputes.recordOpenedDispute(invoice);

    const resolved = await f.disputes.rejectDispute(dispute.id, {
      adminEmail: 'admin@feasly.test',
      note: 'Contract excludes land per the signed copy.',
    });

    expect(resolved.status).toBe('rejected');
    expect(resolved.resolvedBy).toBe('admin@feasly.test');

    const updatedInvoice = await f.commission.getById(invoice.id);
    expect(updatedInvoice.status).toBe('in_review');
    // Fresh 7-day window from the fixed clock.
    expect(updatedInvoice.reviewDueAt?.toISOString()).toBe(
      '2026-10-05T17:00:00.000Z',
    );

    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.tenantKey, tenantKey));
    expect(events.map((e) => e.eventType)).toContain('dispute.resolved');
  });

  it('accept/reject reject non-open disputes and unknown ids', async () => {
    const tenantKey = 'dispute-guards';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);
    const dispute = await f.disputes.recordOpenedDispute(invoice);
    await f.disputes.acceptDispute(dispute.id, {
      adminEmail: 'admin@feasly.test',
    });

    await expect(
      f.disputes.acceptDispute(dispute.id, { adminEmail: 'a@b.c' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.disputes.rejectDispute(dispute.id, { adminEmail: 'a@b.c' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.disputes.getDispute('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('scanSlaBreaches escalates via ops alerts and never auto-resolves', async () => {
    const tenantKey = 'dispute-sla';
    await seedTenant(testDb, tenantKey);
    const past = newFixtures(testDb, PAST_NOW);
    const invoice = await seedDisputedInvoice(testDb, past, tenantKey);
    await past.disputes.recordOpenedDispute(invoice);
    // SLA due 2026-09-21; the scan runs 2026-09-28 — breached.

    const present = newFixtures(testDb, FIXED_NOW);
    const { escalated } = await present.disputes.scanSlaBreaches();
    expect(escalated).toBeGreaterThanOrEqual(1);

    const alert = present.opsAlerts.failures.find(
      (a) => a.type === 'billing_dispute_sla_breached',
    );
    expect(alert).toBeDefined();

    const rows = await testDb.db
      .select()
      .from(billingDisputes)
      .where(eq(billingDisputes.invoiceId, invoice.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].slaBreachedAt).toEqual(FIXED_NOW);
    // NEVER auto-resolved: the dispute stays open until a human acts.
    expect(rows[0].status).toBe('open');

    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.entityId, rows[0].id));
    const breach = events.find((e) => e.eventType === 'dispute.sla_breached');
    expect(breach).toBeDefined();
    expect((breach?.payload as { autoResolved?: boolean })?.autoResolved).toBe(
      false,
    );

    // A second scan does not re-escalate.
    const again = newFixtures(testDb, FIXED_NOW);
    const second = await again.disputes.scanSlaBreaches();
    expect(second.escalated).toBe(0);
    expect(again.opsAlerts.failures).toHaveLength(0);
  });

  it('scanSlaBreaches leaves in-SLA disputes alone', async () => {
    const tenantKey = 'dispute-sla-healthy';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);
    await f.disputes.recordOpenedDispute(invoice);

    const { escalated } = await f.disputes.scanSlaBreaches();
    expect(escalated).toBe(0);
    expect(f.opsAlerts.failures).toHaveLength(0);
  });

  it('the billing facade records a dispute row when a builder disputes', async () => {
    const tenantKey = 'dispute-facade-hook';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedReviewedInvoice(testDb, f, tenantKey);

    const billing = createBillingService({
      // disputeInvoice never touches the lead store; the cast keeps this
      // focused test from stubbing the whole LeadStore surface.
      leadStore: {} as unknown as import('../src/services/lead.store').LeadStore,
      billingHook: f.hook,
      commission: f.commission,
      disputes: f.disputes,
    });
    await billing.disputeInvoice(invoice.id, tenantKey, 'Wrong amount.');

    const rows = await testDb.db
      .select()
      .from(billingDisputes)
      .where(eq(billingDisputes.invoiceId, invoice.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('Wrong amount.');
    expect(rows[0].slaDueAt.toISOString()).toBe('2026-10-05T17:00:00.000Z');
  });

  it('getDisputeDetail returns the snapshot plus the audit trail', async () => {
    const tenantKey = 'dispute-detail';
    await seedTenant(testDb, tenantKey);
    const f = newFixtures(testDb, FIXED_NOW);
    const invoice = await seedDisputedInvoice(testDb, f, tenantKey);
    const dispute = await f.disputes.recordOpenedDispute(invoice);

    const detail = await f.disputes.getDisputeDetail(dispute.id);

    expect(detail.id).toBe(dispute.id);
    expect(detail.evidenceSnapshot.invoiceId).toBe(invoice.id);
    expect(detail.businessDaysRemaining).toBe(5);
    expect(detail.breached).toBe(false);
    const types = detail.auditTrail.map((e) => e.eventType);
    expect(types).toContain('invoice.disputed');
    expect(types).toContain('dispute.opened');
    // Oldest first.
    const times = detail.auditTrail.map((e) => e.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
