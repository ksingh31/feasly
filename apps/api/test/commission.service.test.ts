/**
 * Commission service tests (billing/02).
 *
 * Runs against PGlite with the real migration SQL. The Stripe client and
 * email service are fakes — no network, no real charges. Covers the full
 * invoice lifecycle: draft → in_review → finalized → paid/failed, dispute
 * freeze, one-invoice-per-attribution, SLA-breach flagging, and the
 * append-only billing audit.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createCommissionService,
  type CommissionService,
} from '../src/services/billing/commission.service';
import {
  createBillingAuditService,
  type BillingAuditService,
} from '../src/services/billing/billing-audit.service';
import {
  createAttributionService,
  type AttributionService,
} from '../src/services/billing/attribution.service';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import { estimates, leads, tenants, billingEvents, commissionInvoices } from '../src/db/schema';
import { ErrorCodes } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const BILLING = {
  model: 'commission' as const,
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

const FIXED_NOW = new Date('2026-09-24T12:00:00.000Z');

let idCounter = 0;
function nextId(): string {
  return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
}

let piCounter = 0;

/** Fake Stripe: records calls, never touches the network. */
function fakeStripe(): StripeService & { calls: unknown[] } {
  const calls: unknown[] = [];
  const service: StripeService = {
    isConfigured: true,
    testMode: true,
    createCustomer: async (input) => {
      calls.push({ op: 'createCustomer', input });
      return { id: 'cus_test_123' };
    },
    createSetupIntent: async (customerId) => {
      calls.push({ op: 'createSetupIntent', customerId });
      return { id: 'seti_test_123', clientSecret: 'seti_test_secret' };
    },
    createOffSessionPaymentIntent: async (input, idempotencyKey) => {
      calls.push({ op: 'createOffSessionPaymentIntent', input, idempotencyKey });
      piCounter += 1;
      return { id: `pi_test_${piCounter}`, status: 'requires_capture' };
    },
    createSubscription: async (input) => {
      calls.push({ op: 'createSubscription', input });
      return { id: 'sub_test_123', status: 'active' };
    },
    cancelSubscription: async (subscriptionId) => {
      calls.push({ op: 'cancelSubscription', subscriptionId });
      return { id: subscriptionId };
    },
    refundPaymentIntent: async (paymentIntentId, idempotencyKey) => {
      calls.push({ op: 'refundPaymentIntent', paymentIntentId, idempotencyKey });
      return { id: 're_test_1', status: 'succeeded' };
    },
    verifyWebhook: () => {
      throw new Error('not used in these tests');
    },
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
    getCustomerId: async (tenantKey: string) => {
      calls.push({ op: 'getCustomerId', tenantKey });
      return 'cus_test_123';
    },
  };
  return Object.assign(service, { calls });
}

/** Fake email: records sends, never sends. */
function fakeEmail(): EmailService & { sent: unknown[] } {
  const sent: unknown[] = [];
  const service = {
    sendMagicLink: async (input: unknown) => {
      sent.push({ op: 'sendMagicLink', input });
      return { sent: true };
    },
    sendPartnerShare: async (input: unknown) => {
      sent.push({ op: 'sendPartnerShare', input });
      return { sent: true };
    },
    sendCallbackConfirmation: async (input: unknown) => {
      sent.push({ op: 'sendCallbackConfirmation', input });
      return { sent: true };
    },
    sendNudge: async (input: unknown) => {
      sent.push({ op: 'sendNudge', input });
      return { sent: true };
    },
    sendOpsAlert: async (input: unknown) => {
      sent.push({ op: 'sendOpsAlert', input });
      return { sent: true };
    },
  };
  return Object.assign(service as unknown as EmailService, { sent });
}

interface Fixtures {
  commission: CommissionService;
  attribution: AttributionService;
  audit: BillingAuditService;
  stripe: StripeService & { calls: unknown[] };
  email: EmailService & { sent: unknown[] };
}

function newServices(testDb: TestDb): Fixtures {
  const stripe = fakeStripe();
  const email = fakeEmail();
  const attribution = createAttributionService({
    db: testDb.db,
    billing: BILLING,
    now: () => new Date(FIXED_NOW),
    newId: nextId,
  });
  const audit = createBillingAuditService({ db: testDb.db, newId: nextId });
  const commission = createCommissionService({
    db: testDb.db,
    billing: BILLING,
    attribution,
    audit,
    stripe,
    email,
    opsInbox: 'ops@example.com',
    now: () => new Date(FIXED_NOW),
    newId: nextId,
  });
  return { commission, attribution, audit, stripe, email };
}

async function seedTenant(testDb: TestDb, key = 'test-builder'): Promise<void> {
  await testDb.db.insert(tenants).values({
    tenantKey: key,
    businessName: 'Test Builder Inc',
    displayName: 'Test Builder',
    accentColor: '#B08D57',
    allowedOrigins: ['https://test-builder.example'],
    stripeCustomerId: 'cus_test_123',
  });
}

async function seedAttribution(
  testDb: TestDb,
  attribution: AttributionService,
  tenantKey = 'test-builder',
): Promise<string> {
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
  const intro = await attribution.recordIntroduction({
    leadId,
    tenantKey,
    introducedAt: new Date('2026-03-01T10:00:00.000Z'),
  });
  // Report a $500,000 signed contract (within window + SLA).
  const reported = await attribution.reportContract({
    attributionId: intro.id,
    contractValueCents: 50_000_000,
    contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
    reportedAt: new Date('2026-06-05T10:00:00.000Z'),
  });
  return reported.id;
}

describe('commission service', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('creates a draft invoice at 1% of the reported contract', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb);
    const attributionId = await seedAttribution(testDb, attribution);

    const invoice = await commission.createDraftInvoice(attributionId);

    expect(invoice).toMatchObject({
      attributionId,
      contractValueCents: 50_000_000,
      commissionCents: 500_000, // 1% of $500,000
      currency: 'CAD',
      status: 'draft',
      slaBreached: false,
    });
  });

  it('creates exactly one invoice per attribution (idempotent on retry)', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'one-invoice-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'one-invoice-builder',
    );

    const first = await commission.createDraftInvoice(attributionId);
    // Retried won event: returns the existing invoice, never a 409 and
    // never a second row.
    const second = await commission.createDraftInvoice(attributionId);
    expect(second.id).toBe(first.id);
    const count = await testDb.rows<{ n: string | number }>(
      `select count(*) as n from commission_invoices where attribution_id = '${attributionId}'`,
    );
    expect(Number(count[0].n)).toBe(1);
  });

  it('survives concurrent won events for the same attribution (DB backstop)', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'race-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'race-builder',
    );

    // Two won events racing: both pass the findFirst check before either
    // inserts. The UNIQUE backstop (migration 0033) makes exactly one win;
    // the loser returns the winner's invoice instead of 500ing.
    const [a, b] = await Promise.all([
      commission.createDraftInvoice(attributionId),
      commission.createDraftInvoice(attributionId),
    ]);
    expect(a.id).toBe(b.id);
    const count = await testDb.rows<{ n: string | number }>(
      `select count(*) as n from commission_invoices where attribution_id = '${attributionId}'`,
    );
    expect(Number(count[0].n)).toBe(1);
  });

  it('rejects a duplicate attribution_id at the database level', async () => {
    const { attribution } = newServices(testDb);
    await seedTenant(testDb, 'db-backstop-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'db-backstop-builder',
    );
    const record = await attribution.getById(attributionId);
    // Raw inserts bypassing the service: the constraint itself must hold.
    const values = {
      id: randomUUID(),
      tenantKey: 'db-backstop-builder',
      attributionId,
      leadId: record.leadId,
      contractValueCents: 50_000_000,
      commissionCents: 500_000,
    };
    await testDb.db.insert(commissionInvoices).values(values);
    await expect(
      testDb.db
        .insert(commissionInvoices)
        .values({ ...values, id: randomUUID() }),
    ).rejects.toThrow();
  });

  it('flags + alerts when the contract was reported after the 14-day SLA', async () => {
    const { commission, attribution, email } = newServices(testDb);
    await seedTenant(testDb, 'sla-builder');
    const estimateId = randomUUID();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: '456-test-ave-calgary',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    const leadId = randomUUID();
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: '456-test-ave-calgary',
      email: 'late@example.com',
      name: 'Late Reporter',
      timeline: '6-12 months',
      consentTs: new Date('2026-03-01T09:00:00.000Z'),
    });
    const intro = await attribution.recordIntroduction({
      leadId,
      tenantKey: 'sla-builder',
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    // Signed June 1, reported June 20 — 19 days later (SLA is 14).
    const reported = await attribution.reportContract({
      attributionId: intro.id,
      contractValueCents: 40_000_000,
      contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
      reportedAt: new Date('2026-06-20T10:00:00.000Z'),
    });

    const invoice = await commission.createDraftInvoice(reported.id);

    expect(invoice.slaBreached).toBe(true);
    // Ops was alerted about the SLA breach.
    expect(email.sent.length).toBeGreaterThan(0);
  });

  it('walks the full lifecycle: draft → in_review → finalized → paid', async () => {
    const { commission, attribution, stripe } = newServices(testDb);
    await seedTenant(testDb, 'lifecycle-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'lifecycle-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    expect(draft.status).toBe('draft');

    const inReview = await commission.submitForReview(draft.id);
    expect(inReview.status).toBe('in_review');
    expect(inReview.reviewDueAt).not.toBeNull();
    // 7-day review window from the fixed now.
    const due = new Date(inReview.reviewDueAt!);
    expect(due.toISOString()).toBe('2026-10-01T12:00:00.000Z');

    const finalized = await commission.finalizeInvoice(inReview.id);
    expect(finalized.status).toBe('finalized');
    expect(finalized.stripePaymentIntentId).toMatch(/^pi_test_/);

    // The PaymentIntent used the idempotency key.
    const piCall = stripe.calls.find(
      (c) => (c as { op: string }).op === 'createOffSessionPaymentIntent',
    ) as {
      op: string;
      input: { amountCents: number };
      idempotencyKey: string;
    };
    expect(piCall.input.amountCents).toBe(500_000);
    expect(piCall.idempotencyKey).toBe(
      `feasly:commission_invoices:${finalized.id}:charge`,
    );

    const paid = await commission.markPaidByPaymentIntent(
      finalized.stripePaymentIntentId!,
    );
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();
  });

  it('transitions finalized → failed on payment_intent.payment_failed', async () => {
    const { commission, attribution, email } = newServices(testDb);
    await seedTenant(testDb, 'failed-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'failed-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(inReview.id);

    const failed = await commission.markFailedByPaymentIntent(
      finalized.stripePaymentIntentId!,
    );
    expect(failed.status).toBe('failed');
    // Dunning alert went to ops.
    expect(email.sent.length).toBeGreaterThan(0);
  });

  it('freezes the charge clock while disputed', async () => {
    const { commission, attribution, email } = newServices(testDb);
    await seedTenant(testDb, 'dispute-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'dispute-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);

    const disputed = await commission.disputeInvoice(
      inReview.id,
      'Homeowner says they knew the builder already',
    );
    expect(disputed.status).toBe('disputed');
    expect(disputed.disputeReason).toBe(
      'Homeowner says they knew the builder already',
    );
    // Ops was alerted.
    expect(email.sent.length).toBeGreaterThan(0);

    // A disputed invoice is NOT returned as due for review.
    const pastDue = new Date('2026-12-01T00:00:00.000Z');
    const due = await commission.findDueReviews(pastDue);
    expect(due.find((i) => i.id === disputed.id)).toBeUndefined();

    // Finalizing a disputed invoice is rejected.
    await expect(commission.finalizeInvoice(disputed.id)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });

    // Human resolves: back to review.
    const resumed = await commission.resolveDispute(disputed.id, 'resume');
    expect(resumed.status).toBe('in_review');

    // Or void.
    const disputed2 = await commission.disputeInvoice(resumed.id, 'again');
    const voided = await commission.resolveDispute(disputed2.id, 'void');
    expect(voided.status).toBe('void');
  });

  it('webhook payment for a disputed invoice stays disputed (freeze holds)', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'webhook-freeze-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'webhook-freeze-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    const disputed = await commission.disputeInvoice(
      inReview.id,
      'prior relationship',
    );
    expect(disputed.status).toBe('disputed');

    // Simulate the pre-fix race outcome: a finalize that slipped a
    // PaymentIntent onto the invoice before the dispute won. The webhook
    // handler must still refuse to move it.
    const piId = 'pi_test_disputed_race';
    await testDb.db
      .update(commissionInvoices)
      .set({ stripePaymentIntentId: piId })
      .where(eq(commissionInvoices.id, disputed.id));

    const result = await commission.markPaidByPaymentIntent(piId);
    expect(result.status).toBe('disputed');
    expect(result.paidAt).toBeNull();

    // No charge recorded: status unchanged on re-read.
    const reread = await commission.getById(disputed.id);
    expect(reread.status).toBe('disputed');
    expect(reread.paidAt).toBeNull();

    // Audit trail written — the blocked attempt is NOT silent.
    const events = await testDb.db.select().from(billingEvents);
    const blocked = events.filter(
      (e) =>
        e.entityId === disputed.id &&
        e.eventType === 'invoice.charge_blocked_disputed',
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload).toMatchObject({
      attempted: 'paid',
      paymentIntentId: piId,
    });
  });

  it('webhook failure for a disputed invoice stays disputed (no dunning)', async () => {
    const { commission, attribution, email } = newServices(testDb);
    await seedTenant(testDb, 'webhook-freeze-fail-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'webhook-freeze-fail-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    const disputed = await commission.disputeInvoice(inReview.id, 'duplicate');
    const piId = 'pi_test_disputed_race_fail';
    await testDb.db
      .update(commissionInvoices)
      .set({ stripePaymentIntentId: piId })
      .where(eq(commissionInvoices.id, disputed.id));

    const sentBefore = email.sent.length;
    const result = await commission.markFailedByPaymentIntent(piId);
    expect(result.status).toBe('disputed');

    // No dunning alert fired for a frozen invoice.
    expect(email.sent.length).toBe(sentBefore);

    const events = await testDb.db.select().from(billingEvents);
    const blocked = events.filter(
      (e) =>
        e.entityId === disputed.id &&
        e.eventType === 'invoice.charge_blocked_disputed',
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload).toMatchObject({ attempted: 'failed' });
  });

  it('dispute vs finalize race: loser gets 409, exactly one state wins', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'transition-race-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'transition-race-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);

    // Both pass their status pre-checks before either UPDATE lands; the
    // atomic conditional UPDATE lets exactly one through.
    const results = await Promise.allSettled([
      commission.disputeInvoice(inReview.id, 'race dispute'),
      commission.finalizeInvoice(inReview.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
    ).toMatchObject({ code: ErrorCodes.CONFLICT });

    const final = await commission.getById(inReview.id);
    expect(['disputed', 'finalized']).toContain(final.status);
  });

  it('illegal transition out of a state throws 409 (not a silent no-op)', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'illegal-transition-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'illegal-transition-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    // A payment webhook for a draft invoice (PI attached out of band):
    // draft → paid is not a legal transition.
    const piId = 'pi_test_illegal_transition';
    await testDb.db
      .update(commissionInvoices)
      .set({ stripePaymentIntentId: piId })
      .where(eq(commissionInvoices.id, draft.id));

    await expect(
      commission.markPaidByPaymentIntent(piId),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    const reread = await commission.getById(draft.id);
    expect(reread.status).toBe('draft');
  });

  it('rejects invalid status transitions', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'transition-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'transition-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    // Can't finalize a draft (must go through review first).
    await expect(commission.finalizeInvoice(draft.id)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
    // Can't dispute a draft.
    await expect(
      commission.disputeInvoice(draft.id, 'reason'),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
  });

  it('appends one billing_events row per state change (append-only audit)', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'audit-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'audit-builder',
    );

    const draft = await commission.createDraftInvoice(attributionId);
    await commission.submitForReview(draft.id);

    const rows = await testDb.db
      .select()
      .from(billingEvents);
    const invoiceEvents = rows.filter(
      (r) => r.entityId === draft.id && r.entityType === 'commission_invoice',
    );
    // created + submitted for review.
    expect(invoiceEvents.length).toBe(2);
    expect(invoiceEvents.map((r) => r.eventType).sort()).toEqual([
      'invoice.created',
      'invoice.status_changed',
    ]);
    // Every event carries the tenant key.
    for (const event of invoiceEvents) {
      expect(event.tenantKey).toBe('audit-builder');
    }
  });

  it('returns 404 for an unknown invoice id', async () => {
    const { commission } = newServices(testDb);
    await expect(commission.getById(randomUUID())).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it('refuses to operate when BILLING_MODEL is not commission', async () => {
    const flatBilling = { ...BILLING, model: 'flat' as const };
    const stripe = fakeStripe();
    const email = fakeEmail();
    const attribution = createAttributionService({
      db: testDb.db,
      billing: flatBilling,
      now: () => new Date(FIXED_NOW),
      newId: nextId,
    });
    const audit = createBillingAuditService({ db: testDb.db, newId: nextId });
    const commission = createCommissionService({
      db: testDb.db,
      billing: flatBilling,
      attribution,
      audit,
      stripe,
      email,
      opsInbox: 'ops@example.com',
      now: () => new Date(FIXED_NOW),
      newId: nextId,
    });
    await expect(
      commission.createDraftInvoice(randomUUID()),
    ).rejects.toMatchObject({ code: ErrorCodes.BILLING_MODEL_MISMATCH });
  });
});
