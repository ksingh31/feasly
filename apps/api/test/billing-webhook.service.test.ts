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
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
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
import { createChargebackService } from '../src/services/billing/chargeback.service';
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
    // #716 card lifecycle — unused here.
    updateCustomer: async () => undefined,
    getDefaultPaymentMethodId: async () => null,
    setDefaultPaymentMethod: async () => undefined,
    detachPaymentMethod: async (id: string) => ({ id }),
    clearCustomerId: async () => null,
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
    findRefundByMetadata: async () => null,
    refundPaymentIntent: async (paymentIntentId) => ({ id: 're_test', status: 'succeeded' }),
    retrievePaymentIntent: async (id: string) => ({ id, status: 'processing' }),
    getPaymentIntentConfirmation: async (id: string) => ({ id, status: 'requires_action', clientSecret: `${id}_secret_test` }),
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
        commissionInvoiceId:
          payload.data?.object?.metadata?.feasly_commission_invoice_id,
        failureMessage: payload.data?.object?.last_payment_error?.message,
        declineCode: payload.data?.object?.last_payment_error?.decline_code,
        errorCode: payload.data?.object?.last_payment_error?.code,
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
    sendFollowUp: noop,
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
      chargebacks: createChargebackService({
        db: testDb.db,
        audit,
        commission,
        email,
        opsInbox: 'ops@example.com',
      }),
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
      chargebacks: createChargebackService({
        db: testDb.db,
        audit,
        commission,
        email,
        opsInbox: 'ops@example.com',
      }),
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
  // ── #712: requires_action / processing + webhook-before-response ──────

  async function seedInReviewInvoice(tenantKey: string) {
    await testDb.db.insert(tenants).values({
      tenantKey,
      businessName: `${tenantKey} Builder`,
      displayName: tenantKey,
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: 'cus_test_123',
    });
    const estimateId = nextId();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: `${tenantKey}-st`,
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    const leadId = nextId();
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: `${tenantKey}-st`,
      email: `${tenantKey}@example.com`,
      name: 'Homeowner',
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
    return commission.submitForReview(draft.id);
  }

  it('moves a finalized invoice to action_required on payment_intent.requires_action (#712)', async () => {
    const inReview = await seedInReviewInvoice('webhook-3ds-builder');
    const finalized = await commission.finalizeInvoice(inReview.id);
    expect(finalized.status).toBe('finalized');
    const event = {
      id: 'evt_3ds_1',
      type: 'payment_intent.requires_action',
      data: { object: { id: finalized.stripePaymentIntentId, object: 'payment_intent' } },
    };
    const { body, signature } = signPayload(event);
    await expect(webhook.handleWebhook(body, signature)).resolves.toEqual({ received: true, duplicate: false });
    expect((await commission.getById(inReview.id)).status).toBe('action_required');
    // A second requires_action event (new id) for the same intent: unchanged.
    const second = signPayload({ ...event, id: 'evt_3ds_2' });
    await webhook.handleWebhook(second.body, second.signature);
    const rows = (await auditRowsFor(inReview.id)).filter((r) => r.eventType === 'invoice.action_required');
    expect(rows).toHaveLength(1);
  });

  // Real Stripe: an off-session 3DS demand arrives as payment_intent.payment_failed
  // with last_payment_error.code = authentication_required (never requires_action).
  function authRequiredFailedEvent(eventId: string, piId: string, invoiceId?: string): unknown {
    return {
      id: eventId,
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: piId,
          object: 'payment_intent',
          status: 'requires_payment_method',
          ...(invoiceId ? { metadata: { feasly_commission_invoice_id: invoiceId } } : {}),
          last_payment_error: {
            code: 'authentication_required',
            message: 'This payment requires authentication.',
          },
        },
      },
    };
  }

  async function chargeFailedRows(invoiceId: string) {
    return (await auditRowsFor(invoiceId)).filter((r) => r.eventType === 'invoice.charge_failed');
  }

  it('charge step first: a later authentication_required payment_failed leaves the invoice action_required (#712)', async () => {
    const inReview = await seedInReviewInvoice('webhook-sca-charge-first');
    const piId = 'pi_sca_charge_first';
    const original = stripe.createOffSessionPaymentIntent;
    stripe.createOffSessionPaymentIntent = async () => ({
      id: piId,
      status: 'requires_payment_method',
      errorCode: 'authentication_required',
      failureMessage: 'This payment requires authentication.',
    });
    try {
      expect((await commission.finalizeInvoice(inReview.id)).status).toBe('action_required');
    } finally {
      stripe.createOffSessionPaymentIntent = original;
    }
    const alertsBefore = opsAlerts.length;

    const { body, signature } = signPayload(authRequiredFailedEvent('evt_sca_cf_1', piId, inReview.id));
    await expect(webhook.handleWebhook(body, signature)).resolves.toEqual({ received: true, duplicate: false });

    expect((await commission.getById(inReview.id)).status).toBe('action_required');
    expect(await chargeFailedRows(inReview.id)).toHaveLength(0);
    const actionRows = (await auditRowsFor(inReview.id)).filter((r) => r.eventType === 'invoice.action_required');
    expect(actionRows).toHaveLength(1);
    expect(opsAlerts.length - alertsBefore).toBe(0);
    // Still confirmable on-session.
    await expect(commission.createPaymentConfirmation(inReview.id)).resolves.toMatchObject({ paymentIntentId: piId });
  });

  it('webhook first: an authentication_required payment_failed moves a finalized invoice to action_required, not failed (#712)', async () => {
    const inReview = await seedInReviewInvoice('webhook-sca-webhook-first');
    // The charge call reported an in-flight status, so the invoice stays finalized.
    const finalized = await commission.finalizeInvoice(inReview.id);
    expect(finalized.status).toBe('finalized');
    const piId = finalized.stripePaymentIntentId!;
    const alertsBefore = opsAlerts.length;

    const { body, signature } = signPayload(authRequiredFailedEvent('evt_sca_wf_1', piId, inReview.id));
    await expect(webhook.handleWebhook(body, signature)).resolves.toEqual({ received: true, duplicate: false });

    expect((await commission.getById(inReview.id)).status).toBe('action_required');
    expect(await chargeFailedRows(inReview.id)).toHaveLength(0);
    expect(opsAlerts.length - alertsBefore).toBe(0);
    await expect(commission.createPaymentConfirmation(inReview.id)).resolves.toMatchObject({ paymentIntentId: piId });

    // Another authentication_required event (new id) is a no-op: one audit row.
    const again = signPayload(authRequiredFailedEvent('evt_sca_wf_2', piId, inReview.id));
    await webhook.handleWebhook(again.body, again.signature);
    const actionRows = (await auditRowsFor(inReview.id)).filter((r) => r.eventType === 'invoice.action_required');
    expect(actionRows).toHaveLength(1);

    // A genuine decline after the builder's on-session attempt still fails it.
    const declined = signPayload({
      id: 'evt_sca_wf_3',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: piId,
          object: 'payment_intent',
          last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
        },
      },
    });
    await webhook.handleWebhook(declined.body, declined.signature);
    expect((await commission.getById(inReview.id)).status).toBe('failed');
  });

  it('webhook before the charge response: authentication_required payment_failed retries, then settles action_required (#712)', async () => {
    const inReview = await seedInReviewInvoice('webhook-sca-early');
    const piId = 'pi_sca_early';
    const { body, signature } = signPayload(authRequiredFailedEvent('evt_sca_early_1', piId, inReview.id));
    // The charge call has not returned yet: retryable 409, nothing settled.
    await expect(webhook.handleWebhook(body, signature)).rejects.toMatchObject({ status: 409 });

    const original = stripe.createOffSessionPaymentIntent;
    stripe.createOffSessionPaymentIntent = async () => ({
      id: piId,
      status: 'requires_payment_method',
      errorCode: 'authentication_required',
    });
    try {
      await commission.finalizeInvoice(inReview.id);
    } finally {
      stripe.createOffSessionPaymentIntent = original;
    }

    await expect(webhook.handleWebhook(body, signature)).resolves.toEqual({ received: true, duplicate: false });
    expect((await commission.getById(inReview.id)).status).toBe('action_required');
    expect(await chargeFailedRows(inReview.id)).toHaveLength(0);
    const actionRows = (await auditRowsFor(inReview.id)).filter((r) => r.eventType === 'invoice.action_required');
    expect(actionRows).toHaveLength(1);
  });

  it('audits payment_intent.processing without moving the invoice (#712)', async () => {
    const inReview = await seedInReviewInvoice('webhook-processing-builder');
    const finalized = await commission.finalizeInvoice(inReview.id);
    const { body, signature } = signPayload({
      id: 'evt_processing_1',
      type: 'payment_intent.processing',
      data: { object: { id: finalized.stripePaymentIntentId, object: 'payment_intent' } },
    });
    await webhook.handleWebhook(body, signature);
    expect((await commission.getById(inReview.id)).status).toBe('finalized');
    expect((await auditRowsFor('evt_processing_1')).map((r) => r.eventType)).toContain('webhook.payment_processing');
  });

  it('a webhook that beats the charge response fails retryably, then settles on redelivery (#712 AC6)', async () => {
    const inReview = await seedInReviewInvoice('webhook-early-builder');
    const piId = 'pi_early_1';
    const event = {
      id: 'evt_early_1',
      type: 'payment_intent.succeeded',
      data: {
        object: { id: piId, object: 'payment_intent', metadata: { feasly_commission_invoice_id: inReview.id } },
      },
    };
    const { body, signature } = signPayload(event);
    // The charge call has not returned yet: the invoice is still in_review.
    await expect(webhook.handleWebhook(body, signature)).rejects.toMatchObject({ status: 409 });
    expect((await auditRowsFor('evt_early_1')).map((r) => r.eventType)).not.toContain('webhook.orphan_payment_intent');

    // The charge call returns and records the PaymentIntent.
    const original = stripe.createOffSessionPaymentIntent;
    stripe.createOffSessionPaymentIntent = async () => ({ id: piId, status: 'succeeded' });
    try {
      await commission.finalizeInvoice(inReview.id);
    } finally {
      stripe.createOffSessionPaymentIntent = original;
    }

    // Redelivery of the same (unprocessed) event settles it.
    await expect(webhook.handleWebhook(body, signature)).resolves.toEqual({ received: true, duplicate: false });
    expect((await commission.getById(inReview.id)).status).toBe('paid');
  });

  it('routes card lifecycle events to the card service (#716), and only those', async () => {
    const handleCardEvent = vi.fn(async () => undefined);
    const withCard = createBillingWebhookService({
      db: testDb.db,
      stripe,
      audit,
      commission,
      flatPlan,
      chargebacks: createChargebackService({
        db: testDb.db,
        audit,
        commission,
        email,
        opsInbox: 'ops@example.com',
      }),
      commissionCard: { handleCardEvent },
      email,
      opsInbox: 'ops@example.com',
    });
    for (const [i, type] of [
      'setup_intent.succeeded',
      'setup_intent.setup_failed',
      'payment_method.detached',
      'payment_method.updated',
      'payment_method.automatically_updated',
      'customer.deleted',
    ].entries()) {
      const { body, signature } = signPayload({
        id: `evt_card_${i}`,
        type,
        data: { object: { id: `obj_${i}` } },
      });
      await expect(withCard.handleWebhook(body, signature)).resolves.toEqual({
        received: true,
        duplicate: false,
      });
    }
    expect(handleCardEvent).toHaveBeenCalledTimes(6);
    expect(handleCardEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt_card_0', type: 'setup_intent.succeeded' }),
      null,
    );
    // payment_method.attached keeps its own audit-only branch.
    const attached = signPayload({
      id: 'evt_card_attached',
      type: 'payment_method.attached',
      data: { object: { id: 'pm_x' } },
    });
    await withCard.handleWebhook(attached.body, attached.signature);
    expect(handleCardEvent).toHaveBeenCalledTimes(6);
  });

  it('leaves a card event unprocessed when the card service throws, so Stripe retries (#716)', async () => {
    const withCard = createBillingWebhookService({
      db: testDb.db,
      stripe,
      audit,
      commission,
      flatPlan,
      chargebacks: createChargebackService({
        db: testDb.db,
        audit,
        commission,
        email,
        opsInbox: 'ops@example.com',
      }),
      commissionCard: {
        handleCardEvent: vi.fn(async () => {
          throw new Error('stripe down');
        }),
      },
      email,
      opsInbox: 'ops@example.com',
    });
    const { body, signature } = signPayload({
      id: 'evt_card_retry',
      type: 'setup_intent.succeeded',
      data: { object: { id: 'seti_r' } },
    });
    await expect(withCard.handleWebhook(body, signature)).rejects.toThrow('stripe down');
    const [row] = await testDb.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, 'evt_card_retry'));
    expect(row).toBeDefined();
    expect(row?.processedAt ?? null).toBeNull();
  });
});
