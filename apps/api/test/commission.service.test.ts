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
import { estimates, leads, tenants, billingEvents } from '../src/db/schema';
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

  it('creates exactly one invoice per attribution', async () => {
    const { commission, attribution } = newServices(testDb);
    await seedTenant(testDb, 'one-invoice-builder');
    const attributionId = await seedAttribution(
      testDb,
      attribution,
      'one-invoice-builder',
    );

    await commission.createDraftInvoice(attributionId);
    await expect(
      commission.createDraftInvoice(attributionId),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
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
