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
import { and, eq } from 'drizzle-orm';
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
import { estimates, leads, tenants, builders, billingEvents, commissionInvoices } from '../src/db/schema';
import { ErrorCodes } from '../src/middleware/errors';
import type { CommissionInvoice } from '@feasly/contracts';
import { createTestDb, type TestDb } from './pglite-db';
import { SEED_ADMIN_EMAIL } from '../src/config';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';

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
    // #716 card lifecycle — unused here.
    updateCustomer: async () => undefined,
    getDefaultPaymentMethodId: async () => null,
    setDefaultPaymentMethod: async () => undefined,
    detachPaymentMethod: async (id: string) => ({ id }),
    clearCustomerId: async () => null,
    createCustomer: async (input) => {
      calls.push({ op: 'createCustomer', input });
      return { id: 'cus_test_123' };
    },
    createSetupIntent: async (customerId) => {
      calls.push({ op: 'createSetupIntent', customerId });
      return { id: 'seti_test_123', clientSecret: 'seti_test_secret' };
    },
    listPaymentMethods: async (customerId) => {
      calls.push({ op: 'listPaymentMethods', customerId });
      return [];
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
    retrievePaymentIntent: async (id: string) => ({ id, status: 'processing' }),
    getPaymentIntentConfirmation: async (id: string) => ({ id, status: 'requires_action', clientSecret: `${id}_secret_test` }),
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
      return { sent: true, provider: 'log' as const };
    },
    sendPartnerShare: async (input: unknown) => {
      sent.push({ op: 'sendPartnerShare', input });
      return { sent: true, provider: 'log' as const };
    },
    sendCallbackConfirmation: async (input: unknown) => {
      sent.push({ op: 'sendCallbackConfirmation', input });
      return { sent: true, provider: 'log' as const };
    },
    sendNudge: async (input: unknown) => {
      sent.push({ op: 'sendNudge', input });
      return { sent: true, provider: 'log' as const };
    },
    sendOpsAlert: async (input: unknown) => {
      sent.push({ op: 'sendOpsAlert', input });
      return { sent: true, provider: 'log' as const };
    },
    sendCommissionInvoiceReady: async (input: unknown) => {
      sent.push({ op: 'sendCommissionInvoiceReady', input });
      return { sent: true, provider: 'log' as const };
    },
    sendCommissionPaymentReceived: async (input: unknown) => {
      sent.push({ op: 'sendCommissionPaymentReceived', input });
      return { sent: true, provider: 'log' as const };
    },
    sendCommissionPaymentFailed: async (input: unknown) => {
      sent.push({ op: 'sendCommissionPaymentFailed', input });
      return { sent: true, provider: 'log' as const };
    },
    sendCommissionPaymentActionRequired: async (input: unknown) => {
      sent.push({ op: 'sendCommissionPaymentActionRequired', input });
      return { sent: true, provider: 'log' as const };
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
  contractValueCents = 50_000_000,
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
    contractValueCents,
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
    // billing/12: invoice_number is NOT NULL, so each raw insert gets a
    // synthetic number (the duplicate insert keeps the same attribution
    // but needs a distinct invoice number).
    const values = {
      id: randomUUID(),
      tenantKey: 'db-backstop-builder',
      attributionId,
      leadId: record.leadId,
      contractValueCents: 50_000_000,
      commissionCents: 500_000,
      invoiceNumber: 'INV-TEST-DUP-1',
    };
    await testDb.db.insert(commissionInvoices).values(values);
    await expect(
      testDb.db
        .insert(commissionInvoices)
        .values({ ...values, id: randomUUID(), invoiceNumber: 'INV-TEST-DUP-2' }),
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
    // created + submitted for review + BILL-04 email audit (no contact).
    expect(invoiceEvents.length).toBe(3);
    expect(invoiceEvents.map((r) => r.eventType).sort()).toEqual([
      'invoice.created',
      'invoice.email_skipped_no_contact',
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

describe('retryCharge (BILL-03)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  /** Drive an invoice to `failed`: draft → in_review → finalized → failed. */
  async function seedFailedInvoice(
    tenantKey: string,
  ): Promise<{ commission: CommissionService; stripe: { calls: unknown[] }; invoiceId: string; firstPi: string }> {
    const { commission, attribution, stripe } = newServices(testDb);
    await seedTenant(testDb, tenantKey);
    const attributionId = await seedAttribution(testDb, attribution, tenantKey);
    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(inReview.id);
    const firstPi = finalized.stripePaymentIntentId!;
    const failed = await commission.markFailedByPaymentIntent(firstPi, 'Your card was declined.');
    return { commission, stripe, invoiceId: failed.id, firstPi };
  }

  it('retries a failed charge: new PaymentIntent, failed → finalized, retry count bumps', async () => {
    const { commission, stripe, invoiceId, firstPi } =
      await seedFailedInvoice('retry-builder-1');
    const retried = await commission.retryCharge(invoiceId);
    expect(retried.status).toBe('finalized');
    expect(retried.retryCount).toBe(1);
    expect(retried.stripePaymentIntentId).not.toBe(firstPi);

    // Distinct idempotency key per retry attempt.
    const piCalls = stripe.calls.filter(
      (c) => (c as { op: string }).op === 'createOffSessionPaymentIntent',
    ) as Array<{ idempotencyKey: string }>;
    expect(piCalls).toHaveLength(2);
    expect(piCalls[1]!.idempotencyKey).toBe(
      `feasly:commission_invoices:${invoiceId}:retry:1`,
    );

    // A second retry gets :retry:2.
    const retried2 = await commission.retryCharge(
      (await commission.markFailedByPaymentIntent(retried.stripePaymentIntentId!, 'Insufficient funds.')).id,
    );
    expect(retried2.retryCount).toBe(2);
    const piCalls2 = stripe.calls.filter(
      (c) => (c as { op: string }).op === 'createOffSessionPaymentIntent',
    ) as Array<{ idempotencyKey: string }>;
    expect(piCalls2[2]!.idempotencyKey).toBe(
      `feasly:commission_invoices:${invoiceId}:retry:2`,
    );
  });

  it('settles a retried charge through the normal webhook path: finalized → paid', async () => {
    const { commission, invoiceId } =
      await seedFailedInvoice('retry-builder-6');
    const retried = await commission.retryCharge(invoiceId);
    expect(retried.status).toBe('finalized');
    const paid = await commission.markPaidByPaymentIntent(
      retried.stripePaymentIntentId!,
    );
    expect(paid.status).toBe('paid');
  });

  it('records the failure reason in the audit payload for the dunning queue', async () => {
    const { commission, invoiceId } =
      await seedFailedInvoice('retry-builder-2');
    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.entityId, invoiceId));
    const failedEvent = events.find(
      (e) => e.eventType === 'invoice.charge_failed',
    );
    expect(failedEvent).toBeDefined();
    expect(
      (failedEvent!.payload as Record<string, unknown>)['failureReason'],
    ).toBe('Your card was declined.');
    await commission.retryCharge(invoiceId);
    const events2 = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.entityId, invoiceId));
    expect(
      events2.some((e) => e.eventType === 'invoice.charge_retried'),
    ).toBe(true);
  });

  it('409s on non-failed invoices and never on disputed ones', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'retry-builder-3');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'retry-builder-3',
    );
    const draft = await commission.createDraftInvoice(attributionId);
    await expect(commission.retryCharge(draft.id)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
    const inReview = await commission.submitForReview(draft.id);
    const disputed = await commission.disputeInvoice(inReview.id, 'wrong amount');
    await expect(commission.retryCharge(disputed.id)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  it('422s past the max-retry cap', async () => {
    const { commission } = newServices(testDb);
    // maxChargeRetries is optional in test fixtures → default 3.
    const { invoiceId } = await seedFailedInvoice('retry-builder-4');
    for (let n = 0; n < 3; n += 1) {
      const retried = await commission.retryCharge(invoiceId);
      await commission.markFailedByPaymentIntent(
        retried.stripePaymentIntentId!,
      );
    }
    await expect(commission.retryCharge(invoiceId)).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_FAILED,
    });
  });

  it('422s when the tenant has no card on file', async () => {
    const { commission, attribution, stripe } = newServices(testDb);
    await seedTenant(testDb, 'retry-builder-5');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'retry-builder-5',
    );
    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(inReview.id);
    await commission.markFailedByPaymentIntent(
      finalized.stripePaymentIntentId!,
    );
    // Card removed after the failure.
    stripe.getCustomerId = async () => null;
    await expect(commission.retryCharge(finalized.id)).rejects.toMatchObject({
      code: ErrorCodes.BILLING_NOT_CONFIGURED,
    });
  });

  it('409s on a manual-method failed invoice and creates NO Stripe charge', async () => {
    const tenantKey = 'retry-builder-manual';
    const { commission, stripe, invoiceId } =
      await seedFailedInvoice(tenantKey);
    // Staff switches the failed invoice to manual (cheque) — the billing/12
    // flow. The retry must respect the switch, not charge the card anyway.
    const manual = await commission.setInvoicePaymentMethod(
      tenantKey,
      invoiceId,
      'cheque',
    );
    expect(manual.paymentMethod).toBe('cheque');

    const piCallsBefore = stripe.calls.filter(
      (c) => (c as { op: string }).op === 'createOffSessionPaymentIntent',
    ).length;
    await expect(commission.retryCharge(invoiceId)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
      message: expect.stringContaining('manual payment'),
    });
    const piCallsAfter = stripe.calls.filter(
      (c) => (c as { op: string }).op === 'createOffSessionPaymentIntent',
    ).length;
    // The refused retry created no Stripe charge.
    expect(piCallsAfter).toBe(piCallsBefore);

    // The invoice is untouched: still failed, retry budget not consumed.
    const invoice = await commission.getById(invoiceId);
    expect(invoice.status).toBe('failed');
    expect(invoice.retryCount).toBe(0);
  });

  it('still retries a card-method failed invoice (no regression)', async () => {
    const { commission, stripe, invoiceId } =
      await seedFailedInvoice('retry-builder-card');
    const retried = await commission.retryCharge(invoiceId);
    expect(retried.status).toBe('finalized');
    expect(retried.retryCount).toBe(1);
    const piCalls = stripe.calls.filter(
      (c) => (c as { op: string }).op === 'createOffSessionPaymentIntent',
    );
    // Seed finalize (1) + this retry (1).
    expect(piCalls).toHaveLength(2);
  });

  it('finalizeInvoice 409s on a manual-method invoice (defense-in-depth)', async () => {
    const tenantKey = 'retry-builder-manual-finalize';
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, tenantKey);
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      tenantKey,
    );
    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    await commission.setInvoicePaymentMethod(
      tenantKey,
      inReview.id,
      'e_transfer',
    );
    await expect(
      commission.finalizeInvoice(inReview.id),
    ).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
      message: expect.stringContaining('manual payment'),
    });
  });
});

describe('per-builder commission rate (billing/08)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  async function seedBuilderWithRate(
    tenantKey: string,
    ratePercent: number,
  ): Promise<void> {
    // commission_invoices.tenant_key FKs to tenants — seed both rows.
    await testDb.db
      .insert(tenants)
      .values({
        tenantKey,
        businessName: `${tenantKey} Ltd.`,
        displayName: tenantKey,
        accentColor: '#B08D57',
        allowedOrigins: ['https://example.com'],
        stripeCustomerId: 'cus_test_123',
      })
      .onConflictDoNothing();
    await testDb.db
      .insert(builders)
      .values({
        id: randomUUID(),
        tenantKey,
        businessName: `${tenantKey} Ltd.`,
        displayName: tenantKey,
        commissionRatePercent: ratePercent,
      })
      .onConflictDoNothing();
  }

  it('snapshots the builder rate at invoice creation', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedBuilderWithRate('rate-builder', 1.5);
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'rate-builder',
    );

    const invoice = await commission.createDraftInvoice(attributionId);

    // $500,000 × 1.5% = $7,500
    expect(invoice.commissionCents).toBe(750_000);
    expect(invoice.commissionRatePercent).toBe(1.5);
    expect(invoice.effectiveRatePercent).toBe(1.5);
  });

  it('a later rate change does not reprice an existing invoice', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedBuilderWithRate('sticky-rate-builder', 1.5);
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'sticky-rate-builder',
    );
    const invoice = await commission.createDraftInvoice(attributionId);

    // Admin renegotiates the builder to 2% AFTER the invoice exists.
    await testDb.db
      .update(builders)
      .set({ commissionRatePercent: 2 })
      .where(eq(builders.tenantKey, 'sticky-rate-builder'));

    const reread = await commission.getById(invoice.id);
    expect(reread.commissionCents).toBe(750_000);
    expect(reread.commissionRatePercent).toBe(1.5);
    expect(reread.effectiveRatePercent).toBe(1.5);

    // …but the NEXT invoice for the same builder uses the new rate.
    const attributionId2 = await seedAttribution(
      testDb,
      attribution,
      'sticky-rate-builder',
    );
    const invoice2 = await commission.createDraftInvoice(attributionId2);
    expect(invoice2.commissionCents).toBe(1_000_000);
    expect(invoice2.effectiveRatePercent).toBe(2);
  });

  it('falls back to the configured default when the builder row is missing', async () => {
    const { commission, attribution } = newServices(testDb);
    // The tenants row exists (FK) but there is deliberately no builders
    // row for 'legacy-builder' — the invoice still gets made at the 1%
    // config default, and the snapshot records the rate that was
    // actually applied.
    await seedTenant(testDb, 'legacy-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'legacy-builder',
    );

    const invoice = await commission.createDraftInvoice(attributionId);
    expect(invoice.commissionCents).toBe(500_000);
    expect(invoice.commissionRatePercent).toBe(1);
    expect(invoice.effectiveRatePercent).toBe(1);
  });

  it('getCommissionRatePercent returns the builder rate, else the default', async () => {
    const { commission } = newServices(testDb);
    await seedBuilderWithRate('lookup-builder', 2.25);

    await expect(
      commission.getCommissionRatePercent('lookup-builder'),
    ).resolves.toBe(2.25);
    await expect(
      commission.getCommissionRatePercent('no-such-builder'),
    ).resolves.toBe(1);
  });

  it('supports a 0% builder rate (no commission owed)', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedBuilderWithRate('zero-rate-builder', 0);
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'zero-rate-builder',
    );

    const invoice = await commission.createDraftInvoice(attributionId);
    expect(invoice.commissionCents).toBe(0);
    expect(invoice.effectiveRatePercent).toBe(0);
  });

  it('the per-invoice override still wins over the builder rate', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedBuilderWithRate('override-builder', 1.5);
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'override-builder',
    );
    const draft = await commission.createDraftInvoice(attributionId);
    const invoice = await commission.submitForReview(draft.id);
    expect(invoice.effectiveRatePercent).toBe(1.5);

    const repriced = await commission.setCommissionRate(
      invoice.id,
      2,
      SEED_ADMIN_EMAIL,
    );
    // The override wins; the creation snapshot is untouched.
    expect(repriced.commissionRateOverride).toBe(2);
    expect(repriced.commissionRatePercent).toBe(1.5);
    expect(repriced.effectiveRatePercent).toBe(2);
    expect(repriced.commissionCents).toBe(1_000_000);
  });
});

describe('listInvoices (BILL-04)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  async function seedInvoice(
    tenantKey: string,
  ): Promise<{ id: string; createdAt: Date; invoiceNumber: string }> {
    const { commission, attribution } = newServices(testDb);
    // seedTenant is not idempotent — only insert once per key.
    const existing = await testDb.db.query.tenants.findFirst({
      where: eq(tenants.tenantKey, tenantKey),
    });
    if (!existing) {
      await seedTenant(testDb, tenantKey);
    }
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      tenantKey,
    );
    const invoice = await commission.createDraftInvoice(attributionId);
    return {
      id: invoice.id,
      createdAt: invoice.createdAt,
      invoiceNumber: invoice.invoiceNumber,
    };
  }

  it('lists a tenant\'s invoices newest first', async () => {
    const { commission } = newServices(testDb);
    const key = 'list-builder-1';
    const first = await seedInvoice(key);
    // Ensure distinct createdAt for ordering.
    await new Promise((r) => setTimeout(r, 10));
    const second = await seedInvoice(key);

    const list = await commission.listInvoices(key, { limit: 20, offset: 0 });

    expect(list.length).toBe(2);
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
    expect(list[0].tenantKey).toBe(key);
  });

  it('resolves the lead name on each listed invoice', async () => {
    const { commission } = newServices(testDb);
    const key = 'list-builder-leadname';
    await seedInvoice(key);

    const list = await commission.listInvoices(key, { limit: 20, offset: 0 });

    expect(list.length).toBe(1);
    // seedAttribution inserts the lead as 'Test Homeowner'.
    expect(list[0].leadName).toBe('Test Homeowner');
  });

  it('isolates tenants: another tenant\'s invoices never appear', async () => {
    const { commission } = newServices(testDb);
    await seedInvoice('list-builder-a');
    await seedInvoice('list-builder-b');

    const listA = await commission.listInvoices('list-builder-a', {
      limit: 20,
      offset: 0,
    });

    expect(listA.length).toBe(1);
    expect(listA[0].tenantKey).toBe('list-builder-a');
  });

  it('paginates with limit/offset', async () => {
    const { commission } = newServices(testDb);
    const key = 'list-builder-page';
    await seedInvoice(key);
    await seedInvoice(key);
    await seedInvoice(key);

    const page1 = await commission.listInvoices(key, { limit: 2, offset: 0 });
    const page2 = await commission.listInvoices(key, { limit: 2, offset: 2 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(1);
    const ids1 = new Set(page1.map((i) => i.id));
    expect(ids1.has(page2[0].id)).toBe(false);
  });

  it('admin (null tenant) sees all tenants\' invoices', async () => {
    const { commission } = newServices(testDb);
    await seedInvoice('list-builder-admin-a');
    await seedInvoice('list-builder-admin-b');

    const list = await commission.listInvoices(null, { limit: 20, offset: 0 });

    const keys = new Set(list.map((i) => i.tenantKey));
    expect(keys.has('list-builder-admin-a')).toBe(true);
    expect(keys.has('list-builder-admin-b')).toBe(true);
  });

  it('filters by status for the due-invoice banner query', async () => {
    const { commission } = newServices(testDb);
    const key = 'list-builder-status';
    const failed = await seedInvoice(key);
    const inReview = await seedInvoice(key);
    const paid = await seedInvoice(key);
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'failed' })
      .where(eq(commissionInvoices.id, failed.id));
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'in_review' })
      .where(eq(commissionInvoices.id, inReview.id));
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'paid' })
      .where(eq(commissionInvoices.id, paid.id));

    const list = await commission.listInvoices(key, {
      limit: 100,
      offset: 0,
      status: ['failed', 'in_review'],
    });

    const ids = new Set(list.map((i) => i.id));
    expect(ids.has(failed.id)).toBe(true);
    expect(ids.has(inReview.id)).toBe(true);
    expect(ids.has(paid.id)).toBe(false);
  });

  it('clamps limit to 1–100', async () => {
    const { commission } = newServices(testDb);
    const key = 'list-builder-clamp';
    await seedInvoice(key);

    const list = await commission.listInvoices(key, { limit: 500, offset: 0 });
    // Clamped to 100, but only 1 row exists.
    expect(list.length).toBe(1);
  });

  it('filters by invoice number (case-insensitive partial match)', async () => {
    const { commission } = newServices(testDb);
    const key = 'list-builder-invnum';
    const first = await seedInvoice(key);
    const second = await seedInvoice(key);

    const exact = await commission.listInvoices(key, {
      limit: 20,
      offset: 0,
      invoiceNumber: first.invoiceNumber,
    });
    expect(exact.length).toBe(1);
    expect(exact[0].id).toBe(first.id);

    // Partial, case-insensitive: the numeric suffix alone matches.
    const digits = first.invoiceNumber.replace(/\D/g, '');
    const partial = await commission.listInvoices(key, {
      limit: 20,
      offset: 0,
      invoiceNumber: `inv-${digits}`,
    });
    expect(partial.length).toBe(1);
    expect(partial[0].id).toBe(first.id);
    expect(partial.some((i) => i.id === second.id)).toBe(false);

    const none = await commission.listInvoices(key, {
      limit: 20,
      offset: 0,
      invoiceNumber: 'ZZZ-NOMATCH-999',
    });
    expect(none.length).toBe(0);
  });

  it('treats LIKE wildcards in the invoice-number filter as literals', async () => {
    const { commission } = newServices(testDb);
    const key = 'list-builder-invlike';
    await seedInvoice(key);

    // A bare "%" must not match every invoice — it is escaped to a
    // literal, and no invoice number contains one.
    const list = await commission.listInvoices(key, {
      limit: 20,
      offset: 0,
      invoiceNumber: '%',
    });
    expect(list.length).toBe(0);
  });
});

describe('builder billing emails (BILL-04)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  async function seedBuilderWithEmail(
    tenantKey: string,
    email: string,
  ): Promise<void> {
    const existing = await testDb.db.query.tenants.findFirst({
      where: eq(tenants.tenantKey, tenantKey),
    });
    if (!existing) {
      await seedTenant(testDb, tenantKey);
    }
    const existingBuilder = await testDb.db.query.builders.findFirst({
      where: eq(builders.tenantKey, tenantKey),
    });
    if (!existingBuilder) {
      await testDb.db.insert(builders).values({
        id: randomUUID(),
        tenantKey,
        businessName: 'Email Builder Inc',
        displayName: 'Email Builder',
        email,
      });
    }
  }

  it('emails the builder when an invoice enters review', async () => {
    const { commission, attribution, email } = newServices(testDb);
    const key = 'email-review-builder';
    await seedBuilderWithEmail(key, 'billing@example.com');
    const attributionId = await seedAttribution(testDb, attribution, key);

    const draft = await commission.createDraftInvoice(attributionId);
    email.sent.length = 0;
    const inReview = await commission.submitForReview(draft.id);

    expect(inReview.status).toBe('in_review');
    const sent = email.sent.find(
      (s) => (s as { op: string }).op === 'sendCommissionInvoiceReady',
    );
    expect(sent).toBeDefined();
    const input = (sent as { input: { to: string; reviewDueAt: Date } }).input;
    expect(input.to).toBe('billing@example.com');
    expect(input.reviewDueAt).toEqual(inReview.reviewDueAt);
  });

  it('emails a receipt when the charge succeeds', async () => {
    const { commission, attribution, email } = newServices(testDb);
    const key = 'email-paid-builder';
    await seedBuilderWithEmail(key, 'receipts@example.com');
    const attributionId = await seedAttribution(testDb, attribution, key);

    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(inReview.id);
    email.sent.length = 0;
    const paid = await commission.markPaidByPaymentIntent(
      finalized.stripePaymentIntentId!,
    );

    expect(paid.status).toBe('paid');
    const sent = email.sent.find(
      (s) => (s as { op: string }).op === 'sendCommissionPaymentReceived',
    );
    expect(sent).toBeDefined();
    expect((sent as { input: { to: string } }).input.to).toBe(
      'receipts@example.com',
    );
  });

  it('emails "update your card" when the charge fails', async () => {
    const { commission, attribution, email } = newServices(testDb);
    const key = 'email-failed-builder';
    await seedBuilderWithEmail(key, 'dunning@example.com');
    const attributionId = await seedAttribution(testDb, attribution, key);

    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(inReview.id);
    email.sent.length = 0;
    const failed = await commission.markFailedByPaymentIntent(
      finalized.stripePaymentIntentId!,
      'card_declined',
    );

    expect(failed.status).toBe('failed');
    const sent = email.sent.find(
      (s) => (s as { op: string }).op === 'sendCommissionPaymentFailed',
    );
    expect(sent).toBeDefined();
    const input = (sent as { input: { to: string; updateWithinDays: number } })
      .input;
    expect(input.to).toBe('dunning@example.com');
    expect(input.updateWithinDays).toBe(7);
  });

  it('falls back to tenants.fallback_email when builders.email is absent', async () => {
    const { commission, attribution, email } = newServices(testDb);
    const key = 'email-fallback-builder';
    await testDb.db.insert(tenants).values({
      tenantKey: key,
      businessName: 'Fallback Builder Inc',
      displayName: 'Fallback Builder',
      accentColor: '#B08D57',
      allowedOrigins: ['https://fallback.example'],
      stripeCustomerId: 'cus_test_123',
      fallbackEmail: 'fallback@example.com',
    });
    const attributionId = await seedAttribution(testDb, attribution, key);

    const draft = await commission.createDraftInvoice(attributionId);
    email.sent.length = 0;
    await commission.submitForReview(draft.id);

    const sent = email.sent.find(
      (s) => (s as { op: string }).op === 'sendCommissionInvoiceReady',
    );
    expect(sent).toBeDefined();
    expect((sent as { input: { to: string } }).input.to).toBe(
      'fallback@example.com',
    );
  });

  it('audits a skip (no throw) when no contact email exists', async () => {
    const { commission, attribution, email } = newServices(testDb);
    const key = 'email-skip-builder';
    // seedTenant sets no fallbackEmail (defaults to ''); no builders row;
    // no allowlist row → resolveBuilderEmail returns null.
    await seedTenant(testDb, key);
    const attributionId = await seedAttribution(testDb, attribution, key);

    const draft = await commission.createDraftInvoice(attributionId);
    email.sent.length = 0;
    const inReview = await commission.submitForReview(draft.id);

    // Transition succeeded; no email attempted.
    expect(inReview.status).toBe('in_review');
    expect(
      email.sent.some(
        (s) => (s as { op: string }).op === 'sendCommissionInvoiceReady',
      ),
    ).toBe(false);
    // The skip was audited.
    const events = await testDb.rows<{ event_type: string }>(
      `select event_type from billing_events where entity_id = '${draft.id}' and event_type = 'invoice.email_skipped_no_contact'`,
    );
    expect(events.length).toBe(1);
  });
});

describe('markPaidManually', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  /** Drive an invoice to `in_review`: draft → in_review. */
  async function seedInReviewInvoice(tenantKey: string) {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, tenantKey);
    const attributionId = await seedAttribution(testDb, attribution, tenantKey);
    const draft = await commission.createDraftInvoice(attributionId);
    return commission.submitForReview(draft.id);
  }

  it('marks an in_review invoice paid with method, reference, and paid date', async () => {
    const { commission } = newServices(testDb);
    const inReview = await seedInReviewInvoice('markpaid-builder-1');
    const paidAt = new Date('2026-09-29T12:00:00-06:00');

    const paid = await commission.markPaidManually(inReview.id, {
      paymentMethod: 'cheque',
      reference: 'CHQ-1234',
      paidAt,
      adminEmail: SEED_ADMIN_EMAIL,
    });

    expect(paid).toMatchObject({
      status: 'paid',
      manualPaymentMethod: 'cheque',
      paymentReference: 'CHQ-1234',
    });
    expect(paid.paidAt?.toISOString()).toBe('2026-09-29T18:00:00.000Z');
    expect(paid.reviewDueAt).toBeNull();
  });

  it('marks a failed invoice paid — the Stripe charge clock is cancelled', async () => {
    const { commission } = newServices(testDb);
    const inReview = await seedInReviewInvoice('markpaid-builder-2');
    const finalized = await commission.finalizeInvoice(inReview.id);
    const failed = await commission.markFailedByPaymentIntent(
      finalized.stripePaymentIntentId!,
      'Your card was declined.',
    );
    const paid = await commission.markPaidManually(failed.id, {
      paymentMethod: 'e_transfer',
      reference: 'ETF-2026-7788',
      adminEmail: SEED_ADMIN_EMAIL,
    });
    expect(paid.status).toBe('paid');
    expect(paid.manualPaymentMethod).toBe('e_transfer');
    // A later late payment_intent.succeeded webhook is a no-op on the
    // terminal status: no double-charge.
    const secondHit = await commission.markPaidByPaymentIntent(
      finalized.stripePaymentIntentId!,
    );
    expect(secondHit.status).toBe('paid');
    expect(secondHit.manualPaymentMethod).toBe('e_transfer');
    const piEvents = await testDb.rows<{ event_type: string }>(
      `select event_type from billing_events where entity_id = '${failed.id}' and event_type = 'invoice.paid'`,
    );
    expect(piEvents.length).toBe(0);
  });

  it('409s a finalized invoice — an in-flight PaymentIntent cannot be cancelled here', async () => {
    const { commission } = newServices(testDb);
    const inReview = await seedInReviewInvoice('markpaid-builder-3');
    const finalized = await commission.finalizeInvoice(inReview.id);
    // finalized owns a live Stripe PaymentIntent; flipping it to paid would
    // leave Stripe collecting money while our ledger says "paid manually".
    // Mark paid only after the charge fails (→ failed), or refund first.
    await expect(
      commission.markPaidManually(finalized.id, {
        paymentMethod: 'bank_draft',
        adminEmail: SEED_ADMIN_EMAIL,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: ErrorCodes.CONFLICT,
    });
    const still = await commission.getById(finalized.id);
    expect(still.status).toBe('finalized');
  });

  it('excludes a manually paid invoice from auto-finalization reviews', async () => {
    const { commission } = newServices(testDb);
    const inReview = await seedInReviewInvoice('markpaid-builder-4');
    await commission.markPaidManually(inReview.id, {
      paymentMethod: 'cash',
      adminEmail: SEED_ADMIN_EMAIL,
    });
    const due = await commission.findDueReviews(new Date());
    expect(due.some((invoice) => invoice.id === inReview.id)).toBe(false);
  });

  it('409s when the invoice is already paid, and 409s disputed/draft invoices', async () => {
    const { commission } = newServices(testDb);
    const inReview = await seedInReviewInvoice('markpaid-builder-5');
    await commission.markPaidManually(inReview.id, {
      paymentMethod: 'cash',
      adminEmail: SEED_ADMIN_EMAIL,
    });
    await expect(
      commission.markPaidManually(inReview.id, {
        paymentMethod: 'cash',
        adminEmail: SEED_ADMIN_EMAIL,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    const disputed = await commission.disputeInvoice(
      (await seedInReviewInvoice('markpaid-builder-6')).id,
      'wrong amount',
    );
    await expect(
      commission.markPaidManually(disputed.id, {
        paymentMethod: 'cash',
        adminEmail: SEED_ADMIN_EMAIL,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
  });

  it('accepts the expanded payment methods at the service level', async () => {
    const { commission } = newServices(testDb);
    const methods = ['direct_deposit', 'visa', 'mastercard'] as const;
    for (const [i, paymentMethod] of methods.entries()) {
      const inReview = await seedInReviewInvoice(`markpaid-builder-methods-${i}`);
      const paid = await commission.markPaidManually(inReview.id, {
        paymentMethod,
        adminEmail: SEED_ADMIN_EMAIL,
      });
      expect(paid.manualPaymentMethod).toBe(paymentMethod);
    }
  });

  it('400s on an unknown payment method and 404s on an unknown invoice', async () => {
    const { commission } = newServices(testDb);
    const inReview = await seedInReviewInvoice('markpaid-builder-7');
    await expect(
      commission.markPaidManually(inReview.id, {
        // The service-level guard fires for callers that bypass route zod.
        paymentMethod: 'stripe' as never,
        adminEmail: SEED_ADMIN_EMAIL,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    await expect(
      commission.markPaidManually(randomUUID(), {
        paymentMethod: 'cash',
        adminEmail: SEED_ADMIN_EMAIL,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });

  it('audits the manual payment with the method, reference, and admin identity', async () => {
    const { commission } = newServices(testDb);
    const inReview = await seedInReviewInvoice('markpaid-builder-8');
    await commission.markPaidManually(inReview.id, {
      paymentMethod: 'other',
      reference: 'in-person terminal #2',
      adminEmail: SEED_ADMIN_EMAIL,
    });
    const events = await testDb.db
      .select({ payload: billingEvents.payload })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.entityId, inReview.id),
          eq(billingEvents.eventType, 'invoice.paid_manually'),
        ),
      );
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      from: 'in_review',
      paymentMethod: 'other',
      reference: 'in-person terminal #2',
      adminEmail: SEED_ADMIN_EMAIL,
    });
    expect(typeof payload['paidAt']).toBe('string');
  });
});

describe('setCommissionRate', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  /** Drive an invoice to `in_review`: draft → in_review. */
  async function seedInReviewInvoice(tenantKey: string) {
    const { commission, attribution, stripe } = newServices(testDb);
    await seedTenant(testDb, tenantKey);
    const attributionId = await seedAttribution(testDb, attribution, tenantKey);
    const draft = await commission.createDraftInvoice(attributionId);
    return { commission, stripe, invoice: await commission.submitForReview(draft.id) };
  }

  it('recalculates the commission from the new percent of the signed contract value', async () => {
    const { commission, invoice } =
      await seedInReviewInvoice('setrate-builder-1');
    // Signed contract: $500,000 → 1.5% = $7,500.
    expect(invoice.commissionCents).toBe(500_000);

    const updated = await commission.setCommissionRate(
      invoice.id,
      1.5,
      SEED_ADMIN_EMAIL,
    );
    expect(updated).toMatchObject({
      status: 'in_review',
      commissionRateOverride: 1.5,
      commissionCents: 750_000,
      contractValueCents: 50_000_000,
    });
  });

  it('400s on zero, negative, non-finite, and >10 rates', async () => {
    const { commission, invoice } =
      await seedInReviewInvoice('setrate-builder-2');
    for (const bad of [0, -1, 10.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        commission.setCommissionRate(invoice.id, bad, SEED_ADMIN_EMAIL),
      ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    }
  });

  it('409s on paid and finalized invoices, but allows disputed (unpaid)', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'setrate-builder-3');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'setrate-builder-3',
    );
    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);

    // Finalized: a charge is in flight — the amount is already fixed.
    const finalized = await commission.finalizeInvoice(inReview.id);
    await expect(
      commission.setCommissionRate(finalized.id, 2, SEED_ADMIN_EMAIL),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    // Paid: settled invoices are never repriced.
    const paid = await commission.markPaidByPaymentIntent(
      finalized.stripePaymentIntentId!,
    );
    expect(paid.status).toBe('paid');
    await expect(
      commission.setCommissionRate(paid.id, 2, SEED_ADMIN_EMAIL),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    // Disputed: unpaid — an admin resolving a dispute may fix the rate.
    const { invoice: inReview2 } =
      await seedInReviewInvoice('setrate-builder-4');
    const disputed = await commission.disputeInvoice(inReview2.id, 'wrong amount');
    const repriced = await commission.setCommissionRate(
      disputed.id,
      2,
      SEED_ADMIN_EMAIL,
    );
    expect(repriced).toMatchObject({
      status: 'disputed',
      commissionRateOverride: 2,
      commissionCents: 1_000_000,
    });
  });

  it('uses the overridden rate in the Stripe PaymentIntent description', async () => {
    const { commission, stripe, invoice } =
      await seedInReviewInvoice('setrate-builder-5');
    await commission.setCommissionRate(invoice.id, 2.5, SEED_ADMIN_EMAIL);
    await commission.finalizeInvoice(invoice.id);
    const piCalls = stripe.calls.filter(
      (c: unknown) => (c as { op: string }).op === 'createOffSessionPaymentIntent',
    ) as Array<{ input?: { description?: string } }>;
    expect(piCalls.length).toBeGreaterThan(0);
    expect(piCalls[0]!.input?.description).toContain('2.5%');
  });

  it('audits the old → new rate with the admin identity', async () => {
    const { commission, invoice } =
      await seedInReviewInvoice('setrate-builder-6');
    await commission.setCommissionRate(
      invoice.id,
      1.5,
      SEED_ADMIN_EMAIL,
    );
    const events = await testDb.db
      .select({ payload: billingEvents.payload })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.entityId, invoice.id),
          eq(billingEvents.eventType, 'invoice.commission_rate_changed'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload as Record<string, unknown>).toMatchObject({
      fromRatePercent: 1,
      toRatePercent: 1.5,
      oldCommissionCents: 500_000,
      newCommissionCents: 750_000,
      contractValueCents: 50_000_000,
      adminEmail: SEED_ADMIN_EMAIL,
    });
  });
});

describe('builder payment methods (billing/12)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  /** Seed a builders row (the tenant row must already exist). */
  async function seedBuilder(
    tenantKey: string,
    settings?: Record<string, unknown>,
  ): Promise<void> {
    await testDb.db
      .insert(builders)
      .values({
        id: randomUUID(),
        tenantKey,
        businessName: `${tenantKey} Ltd.`,
        displayName: tenantKey,
        ...(settings === undefined ? {} : { settings }),
      })
      .onConflictDoNothing();
  }

  /** Seed a tenant + attribution and create one draft invoice. */
  async function seedDraftInvoice(tenantKey: string) {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, tenantKey);
    const attributionId = await seedAttribution(testDb, attribution, tenantKey);
    const invoice = await commission.createDraftInvoice(attributionId);
    return { commission, attribution, invoice };
  }

  it('assigns the first invoice number INV-0001 in INV-NNNN format', async () => {
    const { invoice } = await seedDraftInvoice('paynum-builder-1');
    expect(invoice.invoiceNumber).toBe('INV-0001');
    expect(invoice.paymentMethod).toBe('card');
  });

  it('invoice numbers are sequential and distinct across invoices', async () => {
    const a = await seedDraftInvoice('paynum-builder-2');
    const b = await seedDraftInvoice('paynum-builder-3');
    expect(a.invoice.invoiceNumber).toBe('INV-0002');
    expect(b.invoice.invoiceNumber).toBe('INV-0003');
    expect(b.invoice.invoiceNumber).toMatch(/^INV-\d{4,}$/);
  });

  it("defaults the builder default and new invoices to 'card'", async () => {
    const { commission } = newServices(testDb);
    // No builders row at all → 'card'.
    await seedTenant(testDb, 'paydef-builder-1');
    expect(await commission.getDefaultPaymentMethod('paydef-builder-1')).toBe(
      'card',
    );
    // Builders row without a settings.defaultPaymentMethod → 'card'.
    await seedTenant(testDb, 'paydef-builder-2');
    await seedBuilder('paydef-builder-2');
    expect(await commission.getDefaultPaymentMethod('paydef-builder-2')).toBe(
      'card',
    );
  });

  it('new invoices inherit the builder default payment method', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'paydef-builder-3');
    await seedBuilder('paydef-builder-3', {
      defaultPaymentMethod: 'cheque',
    });
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'paydef-builder-3',
    );
    const invoice = await commission.createDraftInvoice(attributionId);
    expect(invoice.paymentMethod).toBe('cheque');
  });

  it('a later default change does not rewrite existing invoices', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'paydef-builder-4');
    await seedBuilder('paydef-builder-4');
    await commission.setDefaultPaymentMethod('paydef-builder-4', 'cheque');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'paydef-builder-4',
    );
    const first = await commission.createDraftInvoice(attributionId);

    await commission.setDefaultPaymentMethod('paydef-builder-4', 'bank_draft');

    // Existing invoice keeps the method it was created with...
    expect((await commission.getById(first.id)).paymentMethod).toBe('cheque');
    // ...but the next invoice picks up the new default.
    const attributionId2 = await seedAttribution(
      testDb,
      attribution,
      'paydef-builder-4',
    );
    const second = await commission.createDraftInvoice(attributionId2);
    expect(second.paymentMethod).toBe('bank_draft');
  });

  it('setDefaultPaymentMethod persists, returns the method, and audits from → to', async () => {
    const { commission } = newServices(testDb);
    await seedTenant(testDb, 'paydef-builder-5');
    await seedBuilder('paydef-builder-5');

    const result = await commission.setDefaultPaymentMethod(
      'paydef-builder-5',
      'e_transfer',
    );
    expect(result).toBe('e_transfer');
    expect(await commission.getDefaultPaymentMethod('paydef-builder-5')).toBe(
      'e_transfer',
    );

    const events = await testDb.db
      .select({ payload: billingEvents.payload })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.eventType, 'builder.default_payment_method_changed'),
          eq(billingEvents.tenantKey, 'paydef-builder-5'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload as Record<string, unknown>).toMatchObject({
      from: 'card',
      to: 'e_transfer',
    });
  });

  it('400s on an unknown default method, 404s when the builder row is missing', async () => {
    const { commission } = newServices(testDb);
    await seedTenant(testDb, 'paydef-builder-6');
    await seedBuilder('paydef-builder-6');
    await expect(
      commission.setDefaultPaymentMethod(
        'paydef-builder-6',
        'bitcoin' as 'card',
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    await expect(
      commission.setDefaultPaymentMethod('no-such-builder', 'cheque'),
    ).rejects.toMatchObject({ status: 404, code: ErrorCodes.NOT_FOUND });
  });

  it('changes the payment method on a draft invoice and audits the change', async () => {
    const { commission, invoice } =
      await seedDraftInvoice('payinv-builder-1');

    const updated = await commission.setInvoicePaymentMethod(
      'payinv-builder-1',
      invoice.id,
      'e_transfer',
    );
    expect(updated.paymentMethod).toBe('e_transfer');

    const events = await testDb.db
      .select({ payload: billingEvents.payload })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.entityId, invoice.id),
          eq(billingEvents.eventType, 'invoice.payment_method_changed'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload as Record<string, unknown>).toMatchObject({
      from: 'card',
      to: 'e_transfer',
      autoChargePaused: true,
    });
  });

  it('is a no-op when the method is unchanged (no audit row)', async () => {
    const { commission, invoice } =
      await seedDraftInvoice('payinv-builder-2');

    const updated = await commission.setInvoicePaymentMethod(
      'payinv-builder-2',
      invoice.id,
      'card',
    );
    expect(updated.paymentMethod).toBe('card');

    const events = await testDb.db
      .select({ payload: billingEvents.payload })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.entityId, invoice.id),
          eq(billingEvents.eventType, 'invoice.payment_method_changed'),
        ),
      );
    expect(events).toHaveLength(0);
  });

  it("400s on an unknown method, 403s for another tenant's invoice, 404s for an unknown invoice", async () => {
    const { commission, invoice } =
      await seedDraftInvoice('payinv-builder-3');
    await seedTenant(testDb, 'payinv-builder-4');

    await expect(
      commission.setInvoicePaymentMethod(
        'payinv-builder-3',
        invoice.id,
        'bitcoin' as 'card',
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    await expect(
      commission.setInvoicePaymentMethod(
        'payinv-builder-4',
        invoice.id,
        'cheque',
      ),
    ).rejects.toMatchObject({ status: 403, code: ErrorCodes.FORBIDDEN });
    await expect(
      commission.setInvoicePaymentMethod(
        'payinv-builder-3',
        randomUUID(),
        'cheque',
      ),
    ).rejects.toMatchObject({ status: 404, code: ErrorCodes.NOT_FOUND });
  });

  it('changes the payment method on an unpaid finalized invoice (Karan: every unpaid invoice is changeable)', async () => {
    const { commission, invoice } =
      await seedDraftInvoice('payinv-builder-5');
    const inReview = await commission.submitForReview(invoice.id);
    const finalized = await commission.finalizeInvoice(inReview.id);
    expect(finalized.status).toBe('finalized');

    const updated = await commission.setInvoicePaymentMethod(
      'payinv-builder-5',
      finalized.id,
      'cheque',
    );
    expect(updated.paymentMethod).toBe('cheque');
    expect(updated.status).toBe('finalized');

    const events = await testDb.db
      .select({ payload: billingEvents.payload })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.entityId, invoice.id),
          eq(billingEvents.eventType, 'invoice.payment_method_changed'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload as Record<string, unknown>).toMatchObject({
      from: 'card',
      to: 'cheque',
      autoChargePaused: true,
    });
  });

  it('409s once the invoice is paid, void, or disputed', async () => {
    const { commission, invoice } =
      await seedDraftInvoice('payinv-builder-6');
    const inReview = await commission.submitForReview(invoice.id);
    const paid = await commission.markPaidManually(inReview.id, {
      paymentMethod: 'cheque',
      reference: 'CHQ-1',
      paidAt: new Date('2026-10-01T12:00:00-06:00'),
      adminEmail: null,
    });
    expect(paid.status).toBe('paid');
    await expect(
      commission.setInvoicePaymentMethod(
        'payinv-builder-6',
        paid.id,
        'e_transfer',
      ),
    ).rejects.toMatchObject({ status: 409, code: ErrorCodes.CONFLICT });

    const { commission: commission2, invoice: invoice2 } =
      await seedDraftInvoice('payinv-builder-7');
    const inReview2 = await commission2.submitForReview(invoice2.id);
    const disputed = await commission2.disputeInvoice(
      inReview2.id,
      'prior relationship claim',
    );
    await expect(
      commission2.setInvoicePaymentMethod(
        'payinv-builder-7',
        disputed.id,
        'cheque',
      ),
    ).rejects.toMatchObject({ status: 409, code: ErrorCodes.CONFLICT });

    const voided = await commission2.resolveDispute(disputed.id, 'void');
    expect(voided.status).toBe('void');
    await expect(
      commission2.setInvoicePaymentMethod(
        'payinv-builder-7',
        voided.id,
        'cheque',
      ),
    ).rejects.toMatchObject({ status: 409, code: ErrorCodes.CONFLICT });
  });

  it('findDueReviews skips manual-method invoices — the timer never auto-charges them', async () => {
    const { commission, attribution } = newServices(testDb);
    // Manual-method invoice: default set BEFORE creation.
    await seedTenant(testDb, 'payskip-builder-1');
    await seedBuilder('payskip-builder-1', {
      defaultPaymentMethod: 'cheque',
    });
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'payskip-builder-1',
    );
    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);

    // Card invoice for comparison.
    await seedTenant(testDb, 'payskip-builder-2');
    const attributionId2 = await seedAttribution(
      testDb,
      attribution,
      'payskip-builder-2',
    );
    const draft2 = await commission.createDraftInvoice(attributionId2);
    const inReview2 = await commission.submitForReview(draft2.id);

    const pastDue = new Date('2026-12-01T00:00:00.000Z');
    const due = await commission.findDueReviews(pastDue);
    expect(due.find((i) => i.id === inReview.id)).toBeUndefined();
    expect(due.find((i) => i.id === inReview2.id)).toBeDefined();
    expect(await commission.countSkippedManualReviews(pastDue)).toBe(1);
  });

  it('switching a manual invoice back to card re-arms the auto-charge', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'payskip-builder-3');
    await seedBuilder('payskip-builder-3', {
      defaultPaymentMethod: 'e_transfer',
    });
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'payskip-builder-3',
    );
    const draft = await commission.createDraftInvoice(attributionId);
    const inReview = await commission.submitForReview(draft.id);

    const pastDue = new Date('2026-12-01T00:00:00.000Z');
    expect(
      (await commission.findDueReviews(pastDue)).find(
        (i) => i.id === inReview.id,
      ),
    ).toBeUndefined();

    // in_review is an allowed state for the change.
    const rearmed = await commission.setInvoicePaymentMethod(
      'payskip-builder-3',
      inReview.id,
      'card',
    );
    expect(rearmed.paymentMethod).toBe('card');
    const due = await commission.findDueReviews(pastDue);
    expect(due.find((i) => i.id === inReview.id)).toBeDefined();
  });
});

describe('GST on commission invoices (#714)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  const TAX = {
    enabled: true,
    ratePercent: 5,
    label: 'GST',
    inclusive: false,
    supplierLegalName: 'Example Holdings Ltd.',
    supplierAddress: '100 Example St SW, Calgary AB',
    registrationNumber: '123456789RT0001',
  };

  function servicesWithTax(tax: typeof TAX | undefined) {
    const stripe = fakeStripe();
    const email = fakeEmail();
    const billing = tax ? { ...BILLING, tax } : BILLING;
    const attribution = createAttributionService({
      db: testDb.db,
      billing,
      now: () => new Date(FIXED_NOW),
      newId: nextId,
    });
    const audit = createBillingAuditService({ db: testDb.db, newId: nextId });
    const commission = createCommissionService({
      db: testDb.db,
      billing,
      attribution,
      audit,
      stripe,
      email,
      opsInbox: 'ops@example.com',
      now: () => new Date(FIXED_NOW),
      newId: nextId,
    });
    return { commission, attribution, stripe, email };
  }

  async function seedBuilder(tenantKey: string, ratePercent: number): Promise<void> {
    await testDb.db.insert(tenants).values({
      tenantKey,
      businessName: `${tenantKey} Ltd.`,
      displayName: tenantKey,
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: 'cus_test_123',
    });
    await testDb.db.insert(builders).values({
      id: randomUUID(),
      tenantKey,
      businessName: `${tenantKey} Ltd.`,
      displayName: tenantKey,
      commissionRatePercent: ratePercent,
      email: `billing@${tenantKey}.example`,
    });
  }

  const chargeAmounts = (stripe: { calls: unknown[] }) =>
    stripe.calls
      .filter((c) => (c as { op: string }).op === 'createOffSessionPaymentIntent')
      .map((c) => (c as { input: { amountCents: number } }).input.amountCents);

  it('AC1: $1,250,000 at 1.5% + 5% GST → $18,750 + $937.50 = $19,687.50, Stripe charged 1,968,750', async () => {
    const { commission, attribution, stripe, email } = servicesWithTax(TAX);
    await seedBuilder('gst-ac1', 1.5);
    const attributionId = await seedAttribution(testDb, attribution, 'gst-ac1', 125_000_000);

    const draft = await commission.createDraftInvoice(attributionId);
    expect(draft).toMatchObject({
      commissionCents: 1_875_000,
      subtotalCents: 1_875_000,
      taxRatePercent: 5,
      taxInclusive: false,
      taxCents: 93_750,
      totalCents: 1_968_750,
      taxLabel: 'GST',
    });

    // Contract conformance: the record's tax fields satisfy the public
    // CommissionInvoice DTO (compile-time) and are always populated.
    const dto: Pick<
      CommissionInvoice,
      'subtotalCents' | 'taxRatePercent' | 'taxInclusive' | 'taxCents' | 'totalCents' | 'taxLabel'
    > = draft;
    expect(Object.values(dto).every((v) => v !== undefined)).toBe(true);

    const inReview = await commission.submitForReview(draft.id);
    const ready = email.sent.find(
      (s) => (s as { op: string }).op === 'sendCommissionInvoiceReady',
    ) as { input: { tax?: { taxCents: number; totalCents: number; registrationNumber: string } } };
    expect(ready.input.tax).toMatchObject({
      taxCents: 93_750,
      totalCents: 1_968_750,
      registrationNumber: '123456789RT0001',
    });

    await commission.finalizeInvoice(inReview.id);
    expect(chargeAmounts(stripe)).toEqual([1_968_750]);
  });

  it('AC2: tax disabled → figures and charge match the pre-tax output exactly', async () => {
    for (const [key, tax] of [
      ['gst-off-absent', undefined],
      ['gst-off-flag', { ...TAX, enabled: false }],
    ] as const) {
      const { commission, attribution, stripe, email } = servicesWithTax(tax);
      await seedBuilder(key, 1.5);
      const attributionId = await seedAttribution(testDb, attribution, key, 125_000_000);
      const draft = await commission.createDraftInvoice(attributionId);
      expect(draft).toMatchObject({
        commissionCents: 1_875_000,
        taxRatePercent: 0,
        taxCents: 0,
        totalCents: 1_875_000,
        taxLabel: null,
      });
      await commission.submitForReview(draft.id);
      const ready = email.sent.find(
        (s) => (s as { op: string }).op === 'sendCommissionInvoiceReady',
      ) as { input: Record<string, unknown> };
      expect(ready.input).not.toHaveProperty('tax');
      await commission.finalizeInvoice(draft.id);
      expect(chargeAmounts(stripe)).toEqual([1_875_000]);
    }
  });

  it('AC3: the rate is snapshotted — a later BILLING_TAX_RATE change does not alter existing invoices', async () => {
    const at5 = servicesWithTax(TAX);
    await seedBuilder('gst-snapshot', 1.5);
    const attributionId = await seedAttribution(testDb, at5.attribution, 'gst-snapshot', 125_000_000);
    const invoice = await at5.commission.createDraftInvoice(attributionId);

    // Config moves to 13% (e.g. an HST change) after the invoice exists.
    const at13 = servicesWithTax({ ...TAX, ratePercent: 13 });
    const reread = await at13.commission.getById(invoice.id);
    expect(reread).toMatchObject({ taxRatePercent: 5, taxCents: 93_750, totalCents: 1_968_750 });

    await at13.commission.submitForReview(invoice.id);
    await at13.commission.finalizeInvoice(invoice.id);
    expect(chargeAmounts(at13.stripe)).toEqual([1_968_750]);
  });

  it('AC4: a rate change on an unpaid invoice recalculates tax and total at the snapshotted rate', async () => {
    const { commission, attribution } = servicesWithTax(TAX);
    await seedBuilder('gst-rate-change', 1.5);
    const attributionId = await seedAttribution(testDb, attribution, 'gst-rate-change', 125_000_000);
    const draft = await commission.createDraftInvoice(attributionId);

    // Even if config changed meanwhile, the snapshot (5%) applies.
    const later = servicesWithTax({ ...TAX, ratePercent: 13 });
    const repriced = await later.commission.setCommissionRate(draft.id, 1, null);
    expect(repriced).toMatchObject({
      commissionCents: 1_250_000,
      taxRatePercent: 5,
      taxCents: 62_500,
      totalCents: 1_312_500,
    });
    const audit = await testDb.db.query.billingEvents.findFirst({
      where: and(
        eq(billingEvents.entityId, draft.id),
        eq(billingEvents.eventType, 'invoice.commission_rate_changed'),
      ),
    });
    expect(audit?.payload).toMatchObject({
      oldTaxCents: 93_750,
      newTaxCents: 62_500,
      oldTotalCents: 1_968_750,
      newTotalCents: 1_312_500,
    });
  });

  it('tax-inclusive mode: the commission includes GST', async () => {
    const { commission, attribution, stripe } = servicesWithTax({ ...TAX, inclusive: true });
    await seedBuilder('gst-inclusive', 1.5);
    const attributionId = await seedAttribution(testDb, attribution, 'gst-inclusive', 125_000_000);
    const draft = await commission.createDraftInvoice(attributionId);
    // 1,875,000 × 5/105 = 89,285.71 → 89,286
    expect(draft).toMatchObject({
      commissionCents: 1_785_714,
      taxCents: 89_286,
      totalCents: 1_875_000,
      taxInclusive: true,
    });
    await commission.submitForReview(draft.id);
    await commission.finalizeInvoice(draft.id);
    expect(chargeAmounts(stripe)).toEqual([1_875_000]);
  });

  it('retries charge the total; the receipt email carries the tax breakdown', async () => {
    const { commission, attribution, stripe, email } = servicesWithTax(TAX);
    await seedBuilder('gst-retry', 1.5);
    const attributionId = await seedAttribution(testDb, attribution, 'gst-retry', 125_000_000);
    const draft = await commission.createDraftInvoice(attributionId);
    await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(draft.id);
    await commission.markFailedByPaymentIntent(finalized.stripePaymentIntentId!);
    const retried = await commission.retryCharge(draft.id);
    expect(chargeAmounts(stripe)).toEqual([1_968_750, 1_968_750]);

    email.sent.length = 0;
    await commission.markPaidByPaymentIntent(retried.stripePaymentIntentId!);
    const receipt = email.sent.find(
      (s) => (s as { op: string }).op === 'sendCommissionPaymentReceived',
    ) as { input: { tax?: { totalCents: number } } };
    expect(receipt.input.tax?.totalCents).toBe(1_968_750);
  });

  it('legacy rows (pre-0051) read as zero tax with total = commission', async () => {
    const { commission, attribution } = servicesWithTax(TAX);
    await seedBuilder('gst-legacy', 1);
    const attributionId = await seedAttribution(testDb, attribution, 'gst-legacy');
    const record = await attribution.getById(attributionId);
    const id = randomUUID();
    await testDb.db.insert(commissionInvoices).values({
      id,
      tenantKey: 'gst-legacy',
      attributionId,
      leadId: record.leadId,
      contractValueCents: 50_000_000,
      commissionCents: 500_000,
      invoiceNumber: 'INV-TEST-LEGACY-714',
    });
    const legacy = await commission.getById(id);
    expect(legacy).toMatchObject({
      taxRatePercent: 0,
      taxCents: 0,
      totalCents: 500_000,
      taxLabel: null,
    });
    // Schema repair backfills total_cents for rows the 0051 migration
    // missed (expand step), without touching other figures.
    const before = await testDb.rows<{ total_cents: number | null }>(
      `SELECT total_cents FROM commission_invoices WHERE id = '${id}'`,
    );
    expect(before[0]?.total_cents).toBeNull();
    await testDb.exec(REPAIR_SQL as string);
    const after = await testDb.rows<{ total_cents: number; tax_cents: number; tax_rate_percent: number }>(
      `SELECT total_cents, tax_cents, tax_rate_percent FROM commission_invoices WHERE id = '${id}'`,
    );
    expect(after[0]).toMatchObject({ total_cents: 500_000, tax_cents: 0, tax_rate_percent: 0 });
  });
});

// ── #712: charge outcomes settled at charge time + SCA recovery ──────────

describe('commission service — charge outcomes (#712)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  type ChargeFn = StripeService['createOffSessionPaymentIntent'];

  /** An in-review invoice whose tenant has a billing contact email. */
  async function seedInReview(tenantKey: string, charge?: ChargeFn) {
    const fx = newServices(testDb);
    if (charge) fx.stripe.createOffSessionPaymentIntent = charge;
    await seedTenant(testDb, tenantKey);
    await testDb.db
      .update(tenants)
      .set({ fallbackEmail: `${tenantKey}@example.com` })
      .where(eq(tenants.tenantKey, tenantKey));
    const attributionId = await seedAttribution(testDb, fx.attribution, tenantKey);
    const draft = await fx.commission.createDraftInvoice(attributionId);
    const inReview = await fx.commission.submitForReview(draft.id);
    return { ...fx, inReview };
  }

  async function eventsFor(invoiceId: string) {
    return testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.entityId, invoiceId));
  }

  function sentOps(email: { sent: unknown[] }, op: string) {
    return email.sent.filter((s) => (s as { op: string }).op === op);
  }

  const declined: ChargeFn = async (_input, key) => ({
    id: `pi_declined_${key.length}_${++piCounter}`,
    status: 'requires_payment_method',
    errorCode: 'card_declined',
    declineCode: 'insufficient_funds',
    failureMessage: 'Your card has insufficient funds.',
  });

  it('a decline at finalize → failed with the PaymentIntent, one audit row, one email, one ops alert', async () => {
    const { commission, email, inReview } = await seedInReview('outcome-decline', declined);
    const result = await commission.finalizeInvoice(inReview.id);
    expect(result.status).toBe('failed');
    expect(result.stripePaymentIntentId).toMatch(/^pi_declined_/);
    expect(result.retryCount).toBe(0);

    const failedRows = (await eventsFor(inReview.id)).filter((e) => e.eventType === 'invoice.charge_failed');
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.payload).toMatchObject({
      paymentIntentId: result.stripePaymentIntentId,
      failureReason: 'Your card has insufficient funds.',
      declineCode: 'insufficient_funds',
      source: 'charge',
    });
    expect(sentOps(email, 'sendCommissionPaymentFailed')).toHaveLength(1);
    expect(sentOps(email, 'sendOpsAlert')).toHaveLength(1);

    // The payment_failed webhook that follows is a no-op.
    const again = await commission.markFailedByPaymentIntent(result.stripePaymentIntentId!, 'Your card has insufficient funds.');
    expect(again.status).toBe('failed');
    expect((await eventsFor(inReview.id)).filter((e) => e.eventType === 'invoice.charge_failed')).toHaveLength(1);
    expect(sentOps(email, 'sendCommissionPaymentFailed')).toHaveLength(1);
    expect(sentOps(email, 'sendOpsAlert')).toHaveLength(1);
  });

  it.each([
    ['simulated requires_action', { status: 'requires_action' }],
    ['Stripe authentication_required', { status: 'requires_payment_method', errorCode: 'authentication_required' }],
  ])('a 3DS demand (%s) → action_required, confirm email, not a dunning retry', async (label, report) => {
    const tenantKey = `outcome-3ds-${label.split(' ')[0]}`;
    const { commission, email, inReview } = await seedInReview(tenantKey, async () => ({
      id: `pi_3ds_${++piCounter}`,
      ...report,
    }));
    const result = await commission.finalizeInvoice(inReview.id);
    expect(result.status).toBe('action_required');
    expect(result.retryCount).toBe(0);
    const types = (await eventsFor(inReview.id)).map((e) => e.eventType);
    expect(types).toContain('invoice.action_required');
    expect(types).not.toContain('invoice.charge_failed');
    const confirmEmails = sentOps(email, 'sendCommissionPaymentActionRequired');
    expect(confirmEmails).toHaveLength(1);
    expect((confirmEmails[0] as { input: { invoiceId: string } }).input.invoiceId).toBe(inReview.id);
    expect(sentOps(email, 'sendCommissionPaymentFailed')).toHaveLength(0);
    expect(sentOps(email, 'sendOpsAlert')).toHaveLength(0);

    // payment_intent.requires_action redelivery: unchanged, no second email.
    const again = await commission.markActionRequiredByPaymentIntent(result.stripePaymentIntentId!);
    expect(again.status).toBe('action_required');
    expect(sentOps(email, 'sendCommissionPaymentActionRequired')).toHaveLength(1);

    // The webhook settles the on-session confirmation: action_required → paid.
    const paid = await commission.markPaidByPaymentIntent(result.stripePaymentIntentId!);
    expect(paid.status).toBe('paid');
    expect(sentOps(email, 'sendCommissionPaymentReceived')).toHaveLength(1);
  });

  it('a processing charge stays finalized for the webhook / reconciliation to settle', async () => {
    const { commission, email, inReview } = await seedInReview('outcome-processing', async () => ({
      id: `pi_proc_${++piCounter}`,
      status: 'processing',
    }));
    const result = await commission.finalizeInvoice(inReview.id);
    expect(result.status).toBe('finalized');
    expect(sentOps(email, 'sendCommissionPaymentFailed')).toHaveLength(0);
    expect(sentOps(email, 'sendCommissionPaymentActionRequired')).toHaveLength(0);
    const attempted = (await eventsFor(inReview.id)).find((e) => e.eventType === 'invoice.charge_attempted');
    expect(attempted!.payload).toMatchObject({ outcome: 'processing', paymentIntentStatus: 'processing' });
  });

  it('a transient provider error leaves the invoice in_review; the next attempt reuses the idempotency key', async () => {
    const keys: string[] = [];
    let fail = true;
    const { commission, inReview } = await seedInReview('outcome-transient', async (_input, key) => {
      keys.push(key);
      if (fail) throw Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' });
      return { id: 'pi_after_transient', status: 'succeeded' };
    });
    await expect(commission.finalizeInvoice(inReview.id)).rejects.toThrow('connection reset');
    const still = await commission.getById(inReview.id);
    expect(still.status).toBe('in_review');
    expect(still.stripePaymentIntentId).toBeNull();
    expect((await eventsFor(inReview.id)).map((e) => e.eventType)).not.toContain('invoice.charge_failed');

    fail = false;
    const finalized = await commission.finalizeInvoice(inReview.id);
    expect(finalized.status).toBe('finalized');
    expect(keys).toEqual([
      `feasly:commission_invoices:${inReview.id}:charge`,
      `feasly:commission_invoices:${inReview.id}:charge`,
    ]);
  });

  it('stores the invoice id in the PaymentIntent metadata', async () => {
    const inputs: Array<{ metadata?: Readonly<Record<string, string>> }> = [];
    const { commission, inReview } = await seedInReview('outcome-metadata', async (input) => {
      inputs.push(input);
      return { id: `pi_meta_${++piCounter}`, status: 'succeeded' };
    });
    await commission.finalizeInvoice(inReview.id);
    expect(inputs[0]!.metadata).toEqual({ feasly_commission_invoice_id: inReview.id, feasly_charge_attempt: '0' });
  });

  it('webhook before the charge response: retryable 409, then settles exactly once', async () => {
    let early: Promise<unknown> | undefined;
    const fx = await seedInReview('outcome-race');
    const piId = `pi_race_${++piCounter}`;
    fx.stripe.createOffSessionPaymentIntent = async () => {
      // The payment_failed webhook lands while the charge call is in flight.
      early = fx.commission
        .markFailedByPaymentIntent(piId, 'Your card was declined.', { invoiceIdHint: fx.inReview.id })
        .catch((e: unknown) => e);
      await early;
      return { id: piId, status: 'requires_payment_method', errorCode: 'card_declined', failureMessage: 'Your card was declined.' };
    };
    const result = await fx.commission.finalizeInvoice(fx.inReview.id);
    expect(await early).toMatchObject({ status: 409, code: ErrorCodes.CONFLICT });
    expect(result.status).toBe('failed');
    // The provider redelivers: now a no-op on the settled invoice.
    const redelivered = await fx.commission.markFailedByPaymentIntent(piId, 'Your card was declined.', {
      invoiceIdHint: fx.inReview.id,
    });
    expect(redelivered.status).toBe('failed');
    expect((await eventsFor(fx.inReview.id)).filter((e) => e.eventType === 'invoice.charge_failed')).toHaveLength(1);
    expect(sentOps(fx.email, 'sendCommissionPaymentFailed')).toHaveLength(1);
    expect(sentOps(fx.email, 'sendOpsAlert')).toHaveLength(1);
  });

  it('a webhook for an unknown PaymentIntent with no in-flight invoice is still a 404 (orphan)', async () => {
    const { commission, inReview } = await seedInReview('outcome-orphan');
    await commission.finalizeInvoice(inReview.id); // finalized with its own PI
    await expect(
      commission.markPaidByPaymentIntent('pi_unknown', { invoiceIdHint: inReview.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(commission.markPaidByPaymentIntent('pi_unknown')).rejects.toMatchObject({ status: 404 });
  });

  it('a retry in flight is retryable (409) but a late event for an older attempt is an orphan (404)', async () => {
    const { commission, inReview } = await seedInReview('outcome-attempts', declined);
    await commission.finalizeInvoice(inReview.id); // failed, retryCount 0
    // Retry 1's PaymentIntent, before retryCharge has recorded it.
    await expect(
      commission.markFailedByPaymentIntent('pi_retry1_unrecorded', 'x', { invoiceIdHint: inReview.id, chargeAttemptHint: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    // A stale event from an older attempt (attempt 0) on the failed invoice.
    await expect(
      commission.markFailedByPaymentIntent('pi_attempt0_stale', 'x', { invoiceIdHint: inReview.id, chargeAttemptHint: 0 }),
    ).rejects.toMatchObject({ status: 404 });
    // No attempt hint on a failed invoice: not provably in flight → orphan.
    await expect(
      commission.markFailedByPaymentIntent('pi_unknown_attempt', 'x', { invoiceIdHint: inReview.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a declined retry → failed again with retryCount bumped; the max-retry cap still applies', async () => {
    const { commission, inReview } = await seedInReview('outcome-retry', declined);
    await commission.finalizeInvoice(inReview.id);
    const retried = await commission.retryCharge(inReview.id);
    expect(retried.status).toBe('failed');
    expect(retried.retryCount).toBe(1);
    await commission.retryCharge(inReview.id);
    const third = await commission.retryCharge(inReview.id);
    expect(third.retryCount).toBe(3);
    await expect(commission.retryCharge(inReview.id)).rejects.toMatchObject({ status: 422 });
  });

  it('createPaymentConfirmation returns the client secret only while action_required', async () => {
    const fx = await seedInReview('outcome-confirm', async () => ({ id: `pi_conf_${++piCounter}`, status: 'requires_action' }));
    await expect(fx.commission.createPaymentConfirmation(fx.inReview.id)).rejects.toMatchObject({ status: 409 });
    const waiting = await fx.commission.finalizeInvoice(fx.inReview.id);
    fx.stripe.getPaymentIntentConfirmation = async (id) => ({
      id,
      status: 'requires_payment_method',
      clientSecret: `${id}_secret_live`,
      paymentMethodId: 'pm_1',
    });
    await expect(fx.commission.createPaymentConfirmation(fx.inReview.id)).resolves.toEqual({
      invoiceId: fx.inReview.id,
      paymentIntentId: waiting.stripePaymentIntentId,
      clientSecret: `${waiting.stripePaymentIntentId}_secret_live`,
      paymentMethodId: 'pm_1',
      provider: 'stripe',
    });
    expect((await eventsFor(fx.inReview.id)).map((e) => e.eventType)).toContain('invoice.payment_confirmation_started');
    // Already succeeded at the provider: nothing to confirm.
    fx.stripe.getPaymentIntentConfirmation = async (id) => ({ id, status: 'succeeded', clientSecret: 'x' });
    await expect(fx.commission.createPaymentConfirmation(fx.inReview.id)).rejects.toMatchObject({ status: 409 });
  });

  it('the reviewer timer input never includes failed or action_required invoices', async () => {
    const a = await seedInReview('outcome-timer-a', declined);
    await a.commission.finalizeInvoice(a.inReview.id);
    const b = await seedInReview('outcome-timer-b', async () => ({ id: `pi_t_${++piCounter}`, status: 'requires_action' }));
    await b.commission.finalizeInvoice(b.inReview.id);
    const due = await b.commission.findDueReviews(new Date('2030-01-01T00:00:00.000Z'));
    const ids = due.map((d) => d.id);
    expect(ids).not.toContain(a.inReview.id);
    expect(ids).not.toContain(b.inReview.id);
    await expect(b.commission.finalizeInvoice(b.inReview.id)).rejects.toMatchObject({ status: 409 });
  });

  it('the commission rate cannot change while a 3DS confirmation is pending', async () => {
    const fx = await seedInReview('outcome-rate', async () => ({ id: `pi_r_${++piCounter}`, status: 'requires_action' }));
    await fx.commission.finalizeInvoice(fx.inReview.id);
    await expect(fx.commission.setCommissionRate(fx.inReview.id, 2, null)).rejects.toMatchObject({ status: 409 });
  });
});
