/**
 * Billing webhook service tests (billing/02).
 *
 * Covers Stripe signature verification (raw body, never parsed before
 * verification), event idempotency (duplicate deliveries are ignored), the
 * payment_intent.succeeded/failed transitions, unknown events returning 200,
 * and the BILLING_MODEL mismatch acknowledgement.
 *
 * #711: a handler failure after the event is recorded leaves it unprocessed
 * so Stripe's redelivery re-runs it; processed redeliveries stay no-ops;
 * payment_intent events for unknown PaymentIntents are acknowledged with
 * one audit row and one ops alert.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import {
  createBillingWebhookService,
  type BillingWebhookService,
} from '../src/services/billing/billing-webhook.service';
import {
  createBillingAuditService,
  type BillingAuditService,
} from '../src/services/billing/billing-audit.service';
import {
  createCommissionService,
  type CommissionService,
} from '../src/services/billing/commission.service';
import {
  createAttributionService,
  type AttributionService,
} from '../src/services/billing/attribution.service';
import {
  createFlatPlanService,
  type FlatPlanService,
} from '../src/services/billing/flat-plan.service';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import {
  billingEvents,
  stripeEvents,
  tenants,
  estimates,
  leads,
} from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const WEBHOOK_SECRET = 'whsec_test_123';

const BILLING = {
  model: 'commission' as const,
  commissionRate: 0.01,
  attributionWindowDays: 365,
  reportingSlaDays: 14,
  flatPlanName: 'Builder Standard',
  flatMonthlyCents: 30_000,
  flatCurrency: 'CAD',
  stripeSecretKey: 'sk_test_fake',
  stripeWebhookSecret: WEBHOOK_SECRET,
  stripeFlatPriceId: undefined,
  isProduction: false,
};

let idCounter = 1000;
function nextId(): string {
  return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
}

let piCounter = 100;
function nextPiId(): string {
  return `pi_webhook_${++piCounter}`;
}

/** Minimal fake Stripe that verifies HMAC signatures for real. */
function fakeStripe(): StripeService {
  return {
    isConfigured: true,
    testMode: true,
    createCustomer: async () => ({ id: 'cus_test' }),
    createSetupIntent: async () => ({
      id: 'seti_test',
      clientSecret: 'secret',
    }),
    listPaymentMethods: async () => [],
    createOffSessionPaymentIntent: async () => ({
      id: nextPiId(),
      status: 'requires_capture',
    }),
    createSubscription: async () => ({ id: 'sub_test', status: 'active' }),
    cancelSubscription: async (id) => ({ id }),
    refundPaymentIntent: async (paymentIntentId) => ({ id: 're_test', status: 'succeeded' }),
    retrievePaymentIntent: async (id: string) => ({ id, status: 'processing' }),
    verifyWebhook: (rawBody: Buffer, signature: string | undefined) => {
      if (!signature) {
        const error = new Error('Missing stripe signature') as Error & {
          code: string;
        };
        error.code = 'INVALID_SIGNATURE';
        throw error;
      }
      const expected = createHmac('sha256', WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');
      // Stripe sends `t=...,v1=...`; accept `v1=<hex>` for the test.
      const match = signature.match(/v1=([a-f0-9]+)/);
      if (!match || match[1] !== expected) {
        const error = new Error('Invalid stripe signature') as Error & {
          code: string;
        };
        error.code = 'INVALID_SIGNATURE';
        throw error;
      }
      const payload = JSON.parse(rawBody.toString('utf8'));
      return {
        id: payload.id,
        type: payload.type,
        paymentIntentId:
          payload.data?.object?.id ?? payload.data?.object?.payment_intent,
      };
    },
    getCustomerId: async () => 'cus_test_123',
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
  };
}

/** Ops alerts sent through the fake email service (titles only). */
const opsAlerts: string[] = [];

function fakeEmail(): EmailService {
  const noop = async () => ({ sent: true, provider: 'log' as const });
  return {
    sendMagicLink: noop,
    sendPartnerShare: noop,
    sendCallbackConfirmation: noop,
    sendNudge: noop,
    sendOpsAlert: async (input: { title: string }) => {
      opsAlerts.push(input.title);
      return { sent: true, provider: 'log' as const };
    },
  } as unknown as EmailService;
}

/** Sign a payload the way Stripe does (v1 HMAC). */
function signPayload(payload: unknown): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = `t=1234567890,v1=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  return { body, signature };
}

function paymentIntentEvent(
  eventId: string,
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed',
  piId: string,
): unknown {
  return {
    id: eventId,
    type,
    data: { object: { id: piId, object: 'payment_intent' } },
  };
}

describe('billing webhook service', () => {
  let testDb: TestDb;
  let webhook: BillingWebhookService;
  let commission: CommissionService;
  let attribution: AttributionService;
  let audit: BillingAuditService;
  let flatPlan: FlatPlanService;
  let stripe: StripeService;
  let email: EmailService;

  beforeAll(async () => {
    testDb = await createTestDb();
    stripe = fakeStripe();
    email = fakeEmail();
    audit = createBillingAuditService({
      db: testDb.db,
      newId: nextId,
    });
    attribution = createAttributionService({
      db: testDb.db,
      billing: BILLING,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      newId: nextId,
    });
    commission = createCommissionService({
      db: testDb.db,
      billing: BILLING,
      attribution,
      audit,
      stripe,
      email,
      opsInbox: 'ops@example.com',
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      newId: nextId,
    });
    flatPlan = createFlatPlanService({
      billing: BILLING,
      audit,
      stripe,
      email,
      opsInbox: 'ops@example.com',
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    });
    webhook = createBillingWebhookService({
      db: testDb.db,
      stripe,
      audit,
      commission,
      flatPlan,
      email,
      opsInbox: 'ops@example.com',
    });
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('rejects a missing signature without touching the payload', async () => {
    const { body } = signPayload(
      paymentIntentEvent('evt_1', 'payment_intent.succeeded', 'pi_x'),
    );
    await expect(webhook.handleWebhook(body, undefined)).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
  });

  it('rejects a forged signature', async () => {
    const { body } = signPayload(
      paymentIntentEvent('evt_2', 'payment_intent.succeeded', 'pi_x'),
    );
    await expect(
      webhook.handleWebhook(body, 't=123,v1=deadbeef'),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('marks the invoice paid on payment_intent.succeeded', async () => {
    // Build a finalized invoice directly through the commission service.
    // (Seeding via the service keeps this test honest about the pipeline.)
    const { body, signature } = signPayload(
      paymentIntentEvent('evt_paid_1', 'payment_intent.succeeded', 'pi_paid_1'),
    );

    // Simulate the invoice side: create the invoice row via commission,
    // then finalize it so a PaymentIntent exists.
    const tenantKey = 'webhook-paid-builder';
    await testDb.db.insert(
      tenants,
    ).values({
      tenantKey,
      businessName: 'Webhook Paid Builder',
      displayName: 'Webhook Paid',
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: 'cus_test_123',
    });
    
    const estimateId = nextId();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: 'webhook-paid-st',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    const leadId = nextId();
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: 'webhook-paid-st',
      email: 'paid@example.com',
      name: 'Paid Homeowner',
      timeline: '6-12 months',
      consentTs: new Date('2026-03-01T09:00:00.000Z'),
    });
    const intro = await attribution.recordIntroduction({
      leadId,
      tenantKey,
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const reported = await attribution.reportContract({
      attributionId: intro.id,
      contractValueCents: 60_000_000,
      contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
      reportedAt: new Date('2026-06-05T10:00:00.000Z'),
    });
    const draft = await commission.createDraftInvoice(reported.id);
    const inReview = await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(inReview.id);
    const piId = finalized.stripePaymentIntentId!;

    // Deliver the webhook for THAT payment intent.
    const { body: paidBody, signature: paidSig } = signPayload(
      paymentIntentEvent('evt_paid_2', 'payment_intent.succeeded', piId),
    );
    const result = await webhook.handleWebhook(paidBody, paidSig);

    expect(result.received).toBe(true);
    const invoice = await commission.getById(finalized.id);
    expect(invoice.status).toBe('paid');

    // Idempotency: delivering the same event again is a no-op.
    const again = await webhook.handleWebhook(paidBody, paidSig);
    expect(again.received).toBe(true);
    expect(again.duplicate).toBe(true);
    const stillPaid = await commission.getById(finalized.id);
    expect(stillPaid.status).toBe('paid');

    // The event was claimed exactly once in stripe_events.
    const rows = await testDb.db.select().from(stripeEvents);
    expect(rows.filter((r) => r.eventId === 'evt_paid_2').length).toBe(1);
  });

  it('marks the invoice failed on payment_intent.payment_failed', async () => {
    
    const tenantKey = 'webhook-failed-builder';
    await testDb.db.insert(tenants).values({
      tenantKey,
      businessName: 'Webhook Failed Builder',
      displayName: 'Webhook Failed',
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: 'cus_test_123',
    });
    const estimateId = nextId();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: 'webhook-failed-st',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    const leadId = nextId();
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: 'webhook-failed-st',
      email: 'failed@example.com',
      name: 'Failed Homeowner',
      timeline: '6-12 months',
      consentTs: new Date('2026-03-01T09:00:00.000Z'),
    });
    const intro = await attribution.recordIntroduction({
      leadId,
      tenantKey,
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const reported = await attribution.reportContract({
      attributionId: intro.id,
      contractValueCents: 40_000_000,
      contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
      reportedAt: new Date('2026-06-05T10:00:00.000Z'),
    });
    const draft = await commission.createDraftInvoice(reported.id);
    const inReview = await commission.submitForReview(draft.id);
    const finalized = await commission.finalizeInvoice(inReview.id);

    const { body, signature } = signPayload(
      paymentIntentEvent(
        'evt_failed_1',
        'payment_intent.payment_failed',
        finalized.stripePaymentIntentId!,
      ),
    );
    const result = await webhook.handleWebhook(body, signature);

    expect(result.received).toBe(true);
    const invoice = await commission.getById(finalized.id);
    expect(invoice.status).toBe('failed');
  });

  /** Seed tenant → lead → attribution → finalized invoice; returns it. */
  async function seedFinalizedInvoice(tag: string) {
    const tenantKey = `webhook-${tag}-builder`;
    await testDb.db.insert(tenants).values({
      tenantKey,
      businessName: `Webhook ${tag} Builder`,
      displayName: `Webhook ${tag}`,
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: 'cus_test_123',
    });
    const estimateId = nextId();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: `webhook-${tag}-st`,
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    const leadId = nextId();
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: `webhook-${tag}-st`,
      email: `${tag}@example.com`,
      name: `${tag} Homeowner`,
      timeline: '6-12 months',
      consentTs: new Date('2026-03-01T09:00:00.000Z'),
    });
    const intro = await attribution.recordIntroduction({
      leadId,
      tenantKey,
      introducedAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const reported = await attribution.reportContract({
      attributionId: intro.id,
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
      reportedAt: new Date('2026-06-05T10:00:00.000Z'),
    });
    const draft = await commission.createDraftInvoice(reported.id);
    const inReview = await commission.submitForReview(draft.id);
    return commission.finalizeInvoice(inReview.id);
  }

  async function auditRowsFor(entityId: string) {
    const rows = await testDb.db.select().from(billingEvents);
    return rows.filter((r) => r.entityId === entityId);
  }

  it('re-runs the handler on redelivery after a failure post-claim (#711 AC1)', async () => {
    const finalized = await seedFinalizedInvoice('flaky');
    const piId = finalized.stripePaymentIntentId!;
    // Inject a one-time failure AFTER the event is recorded (a DB blip in
    // the handler).
    let failNext = true;
    const flakyCommission: CommissionService = {
      ...commission,
      markPaidByPaymentIntent: async (id, options) => {
        if (failNext) {
          failNext = false;
          throw new Error('connection terminated unexpectedly (simulated)');
        }
        return commission.markPaidByPaymentIntent(id, options);
      },
    };
    const flakyWebhook = createBillingWebhookService({
      db: testDb.db,
      stripe,
      audit,
      commission: flakyCommission,
      flatPlan,
      email,
      opsInbox: 'ops@example.com',
    });
    const { body, signature } = signPayload(
      paymentIntentEvent('evt_flaky_1', 'payment_intent.succeeded', piId),
    );

    // First delivery: the handler throws → Stripe sees a non-2xx.
    await expect(flakyWebhook.handleWebhook(body, signature)).rejects.toThrow(
      /simulated/,
    );
    expect((await commission.getById(finalized.id)).status).toBe('finalized');
    const [recorded] = await testDb.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, 'evt_flaky_1'));
    expect(recorded?.processedAt).toBeNull();

    // Stripe's redelivery of the SAME event id re-runs the handler.
    const retry = await flakyWebhook.handleWebhook(body, signature);
    expect(retry).toEqual({ received: true, duplicate: false });
    expect((await commission.getById(finalized.id)).status).toBe('paid');
    const [processed] = await testDb.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, 'evt_flaky_1'));
    expect(processed?.processedAt).toBeInstanceOf(Date);
    const received = (await auditRowsFor('evt_flaky_1')).filter(
      (r) => r.eventType === 'webhook.received',
    );
    expect(received.map((r) => r.payload)).toContainEqual(
      expect.objectContaining({ redelivery: true }),
    );
  });

  it('a redelivery of a fully processed event is a no-op with no extra audit rows (#711 AC2)', async () => {
    const finalized = await seedFinalizedInvoice('processed');
    const { body, signature } = signPayload(
      paymentIntentEvent(
        'evt_processed_1',
        'payment_intent.succeeded',
        finalized.stripePaymentIntentId!,
      ),
    );
    const first = await webhook.handleWebhook(body, signature);
    expect(first.duplicate).toBe(false);
    const auditCount = (await testDb.db.select().from(billingEvents)).length;

    const again = await webhook.handleWebhook(body, signature);

    expect(again).toEqual({ received: true, duplicate: true });
    expect((await testDb.db.select().from(billingEvents)).length).toBe(
      auditCount,
    );
  });

  it('acknowledges a payment_intent event for an unknown PaymentIntent with one audit row + one alert (#711 AC3)', async () => {
    const alertsBefore = opsAlerts.length;
    const { body, signature } = signPayload(
      paymentIntentEvent(
        'evt_orphan_1',
        'payment_intent.succeeded',
        'pi_not_ours_1',
      ),
    );

    const result = await webhook.handleWebhook(body, signature);

    expect(result).toEqual({ received: true, duplicate: false });
    const orphanRows = (await auditRowsFor('evt_orphan_1')).filter(
      (r) => r.eventType === 'webhook.orphan_payment_intent',
    );
    expect(orphanRows).toHaveLength(1);
    expect(orphanRows[0]!.payload).toMatchObject({
      stripeType: 'payment_intent.succeeded',
      paymentIntentId: 'pi_not_ours_1',
    });
    expect(opsAlerts.length - alertsBefore).toBe(1);

    // Stripe redelivery: duplicate — no second audit row or alert.
    const again = await webhook.handleWebhook(body, signature);
    expect(again.duplicate).toBe(true);
    expect(
      (await auditRowsFor('evt_orphan_1')).filter(
        (r) => r.eventType === 'webhook.orphan_payment_intent',
      ),
    ).toHaveLength(1);
    expect(opsAlerts.length - alertsBefore).toBe(1);
  });

  it('acknowledges a payment_failed event for an unknown PaymentIntent too', async () => {
    const { body, signature } = signPayload(
      paymentIntentEvent(
        'evt_orphan_2',
        'payment_intent.payment_failed',
        'pi_not_ours_2',
      ),
    );
    const result = await webhook.handleWebhook(body, signature);
    expect(result.received).toBe(true);
    expect(
      (await auditRowsFor('evt_orphan_2')).filter(
        (r) => r.eventType === 'webhook.orphan_payment_intent',
      ),
    ).toHaveLength(1);
  });

  it('acknowledges unknown event types with 200 (no Stripe retries)', async () => {
    const { body, signature } = signPayload({
      id: 'evt_unknown_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_x', object: 'subscription' } },
    });
    const result = await webhook.handleWebhook(body, signature);
    expect(result.received).toBe(true);
  });
});
