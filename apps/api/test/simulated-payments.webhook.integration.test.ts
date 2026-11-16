/**
 * Simulated payment provider × production webhook handler (#753).
 *
 * Real migrations (PGlite), the real Drizzle simulated store, the real
 * StripeService wired to the simulated provider, the real webhook route →
 * BillingWebhookService → CommissionService. Nothing below the provider is
 * faked, so these prove:
 *
 * - AC1: save a test card → invoice charges → success / decline / 3DS reach
 *   the same invoice end states the Stripe path does (paid / failed).
 * - AC2: every event type billing handles can be fired in simulation and is
 *   processed by the production handler (one test per type), plus the
 *   refund/dispute events that land on the handler's default path.
 * - The dev service is tenant-scoped and 404s when the provider is Stripe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBillingAuditService } from '../src/services/billing/billing-audit.service';
import { createAttributionService, type AttributionService } from '../src/services/billing/attribution.service';
import { createBillingWebhookService } from '../src/services/billing/billing-webhook.service';
import { createCommissionCardService, type CommissionCardService } from '../src/services/billing/commission-card.service';
import { createCommissionService, type CommissionService } from '../src/services/billing/commission.service';
import { createFlatPlanService } from '../src/services/billing/flat-plan.service';
import { createInvoiceSummaryStore } from '../src/services/billing/invoice-summary.store';
import {
  createSimulatedPaymentProvider,
  type SimulatedPaymentProvider,
} from '../src/services/billing/simulated-payment.provider';
import { createDrizzleSimulatedPaymentStore } from '../src/services/billing/simulated-payment.store';
import {
  createSimulatedPaymentsService,
  type SimulatedPaymentsService,
} from '../src/services/billing/simulated-payments.service';
import { createStripeService, type StripeService } from '../src/services/billing/stripe.service';
import { createStripeWebhooksRoute } from '../src/routes/stripe-webhooks.route';
import type { EmailService } from '../src/services/email/email.service';
import { billingEvents, estimates, leads, stripeEvents, tenants } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const CARD = {
  ok: '4242424242424242',
  declined: '4000000000000002',
  noFunds: '4000000000009995',
  threeDs: '4000002760003184',
};

const BILLING = {
  model: 'commission' as const,
  commissionRate: 0.01,
  attributionWindowDays: 365,
  reportingSlaDays: 14,
  flatPlanName: 'Builder Standard',
  flatMonthlyCents: 30_000,
  flatCurrency: 'CAD',
  // No Stripe secrets at all: the simulated provider needs none.
  stripeSecretKey: undefined,
  stripeWebhookSecret: undefined,
  stripeFlatPriceId: undefined,
  isProduction: false,
};

let idCounter = 5000;
const nextId = (): string =>
  `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;

/** Every email method resolves as sent (commission notifies builders/ops). */
function fakeEmail(): EmailService {
  return new Proxy(
    {},
    { get: () => async () => ({ sent: true, provider: 'log' as const }) },
  ) as EmailService;
}

describe('simulated payments through the production webhook handler', () => {
  let testDb: TestDb;
  let provider: SimulatedPaymentProvider;
  let stripe: StripeService;
  let commission: CommissionService;
  let attribution: AttributionService;
  let card: CommissionCardService;
  let devService: SimulatedPaymentsService;

  beforeAll(async () => {
    testDb = await createTestDb();
    const email = fakeEmail();
    const now = () => new Date('2026-09-24T12:00:00.000Z');
    provider = createSimulatedPaymentProvider({
      store: createDrizzleSimulatedPaymentStore(testDb.db),
      deliveryDelayMs: 0,
      // Delayed deliveries are flushed explicitly (deliverPendingEvents).
      schedule: () => () => undefined,
      logWarning: () => undefined,
    });
    stripe = createStripeService({
      db: testDb.db,
      billing: BILLING,
      client: provider,
      webhookSecret: provider.webhookSecret,
    });
    const audit = createBillingAuditService({ db: testDb.db, newId: nextId });
    attribution = createAttributionService({ db: testDb.db, billing: BILLING, now, newId: nextId });
    commission = createCommissionService({
      db: testDb.db,
      billing: BILLING,
      attribution,
      audit,
      stripe,
      email,
      opsInbox: 'ops@example.com',
      now,
      newId: nextId,
    });
    const flatPlan = createFlatPlanService({ billing: BILLING, audit, stripe, email, opsInbox: 'ops@example.com', now });
    // #716: the card service handles setup/detach events (single-card model).
    card = createCommissionCardService({
      billing: BILLING,
      audit,
      stripe,
      invoiceSummaries: createInvoiceSummaryStore({ db: testDb.db }),
    });
    const webhook = createBillingWebhookService({
      db: testDb.db,
      stripe,
      audit,
      commission,
      flatPlan,
      commissionCard: card,
      email,
      opsInbox: 'ops@example.com',
      logWarning: () => undefined,
    });
    const route = createStripeWebhooksRoute({ billingWebhooks: webhook });
    provider.connectWebhook((body, signature) => route.handle(body, signature));
    devService = createSimulatedPaymentsService({ provider, stripe, commission, audit });
  }, 60_000);

  afterAll(async () => {
    provider.dispose();
    await testDb.close();
  });

  async function seedTenant(tenantKey: string): Promise<void> {
    await testDb.db.insert(tenants).values({
      tenantKey,
      businessName: `${tenantKey} Builder`,
      displayName: tenantKey,
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
    });
  }

  /** Builder flow: ensure customer → SetupIntent → confirm with a test card. */
  async function saveCard(tenantKey: string, cardNumber: string) {
    await seedTenant(tenantKey);
    await card.ensureCustomer(tenantKey, `${tenantKey}@example.com`);
    const si = await card.createSetupIntent(tenantKey);
    expect(si.provider).toBe('simulated');
    const res = await devService.confirmSetup(tenantKey, si.setupIntentId, cardNumber);
    if (res.status === 'requires_action') {
      await devService.authenticate(tenantKey, si.setupIntentId, 'complete');
    }
    return { setupIntentId: si.setupIntentId, res };
  }

  async function seedInReviewInvoice(tenantKey: string) {
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
      email: `${tenantKey}-home@example.com`,
      name: 'Sim Homeowner',
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
    return commission.submitForReview(draft.id);
  }

  async function chargedInvoice(tenantKey: string, cardNumber: string) {
    await saveCard(tenantKey, cardNumber);
    const inReview = await seedInReviewInvoice(tenantKey);
    const finalized = await commission.finalizeInvoice(inReview.id);
    expect(finalized.status).toBe('finalized');
    expect(finalized.stripePaymentIntentId).toMatch(/^pi_sim_/);
    return finalized;
  }

  async function processedEvents(type: string) {
    const rows = await testDb.db.select().from(stripeEvents).where(eq(stripeEvents.type, type));
    return rows.filter((r) => r.processedAt !== null);
  }

  async function auditTypes(tenantKey: string | null): Promise<string[]> {
    const rows = await testDb.db.select().from(billingEvents);
    return rows.filter((r) => r.tenantKey === tenantKey).map((r) => r.eventType);
  }

  // ── AC1: end-to-end money lifecycle ──────────────────────────────────

  it('saved card + success card → invoice paid via payment_intent.succeeded', async () => {
    const inv = await chargedInvoice('sim-paid', CARD.ok);
    await provider.deliverPendingEvents();
    expect((await commission.getById(inv.id)).status).toBe('paid');
    expect(await stripe.listPaymentMethods((await stripe.getCustomerId('sim-paid'))!)).toEqual([
      expect.objectContaining({ brand: 'visa', last4: '4242' }),
    ]);
  });

  it.each([
    ['sim-declined', CARD.declined, 'Your card was declined.'],
    ['sim-nofunds', CARD.noFunds, 'Your card has insufficient funds.'],
  ])('%s → invoice failed via payment_intent.payment_failed', async (tenantKey, cardNumber, reason) => {
    const inv = await chargedInvoice(tenantKey, cardNumber);
    await provider.deliverPendingEvents();
    expect((await commission.getById(inv.id)).status).toBe('failed');
    // The decline reason reaches the billing audit trail (dunning queue).
    const rows = await testDb.db.select().from(billingEvents);
    expect(
      JSON.stringify(rows.filter((r) => r.tenantKey === tenantKey).map((r) => r.payload)),
    ).toContain(reason);
  });

  it('3DS card → finalized until the challenge, then paid', async () => {
    await seedTenant('sim-3ds');
    await card.ensureCustomer('sim-3ds');
    const si = await card.createSetupIntent('sim-3ds');
    const pending = await devService.confirmSetup('sim-3ds', si.setupIntentId, CARD.threeDs);
    expect(pending.status).toBe('requires_action');
    await devService.authenticate('sim-3ds', si.setupIntentId, 'complete');
    const inReview = await seedInReviewInvoice('sim-3ds');
    const inv = await commission.finalizeInvoice(inReview.id);
    await provider.deliverPendingEvents();
    expect((await commission.getById(inv.id)).status).toBe('finalized');
    const done = await devService.authenticate('sim-3ds', inv.stripePaymentIntentId!, 'complete');
    expect(done.status).toBe('succeeded');
    expect((await commission.getById(inv.id)).status).toBe('paid');
  });

  it('3DS card + failed challenge → invoice failed', async () => {
    const inv = await chargedInvoice('sim-3ds-fail', CARD.threeDs);
    await devService.authenticate('sim-3ds-fail', inv.stripePaymentIntentId!, 'fail');
    expect((await commission.getById(inv.id)).status).toBe('failed');
  });

  it('admin delayed failure on an in-flight charge → invoice failed', async () => {
    const inv = await chargedInvoice('sim-delayed', CARD.threeDs);
    const res = await devService.fireInvoiceEvent(inv.id, 'delayed_failure');
    expect(res).toEqual({
      invoiceId: inv.id,
      paymentIntentId: inv.stripePaymentIntentId,
      kind: 'delayed_failure',
      eventType: 'payment_intent.payment_failed',
    });
    expect((await commission.getById(inv.id)).status).toBe('failed');
    expect(await auditTypes('sim-delayed')).toContain('simulated_payment.fired');
  });

  it('a retry after a decline charges again under a new idempotency key', async () => {
    const inv = await chargedInvoice('sim-retry', CARD.declined);
    await provider.deliverPendingEvents();
    // Builder replaces the card, admin retries.
    const si = await card.createSetupIntent('sim-retry');
    await devService.confirmSetup('sim-retry', si.setupIntentId, CARD.ok);
    const retried = await commission.retryCharge(inv.id);
    expect(retried.stripePaymentIntentId).not.toBe(inv.stripePaymentIntentId);
    await provider.deliverPendingEvents();
    expect((await commission.getById(inv.id)).status).toBe('paid');
  });

  // ── #716 card lifecycle through the production handler ──────────────

  it('saving a second card replaces the first: one card, the default, and the one charged', async () => {
    await saveCard('sim-replace', CARD.declined);
    const customerId = (await stripe.getCustomerId('sim-replace'))!;
    const si = await card.createSetupIntent('sim-replace');
    await devService.confirmSetup('sim-replace', si.setupIntentId, CARD.ok);
    const cards = await stripe.listPaymentMethods(customerId);
    expect(cards).toEqual([expect.objectContaining({ last4: '4242' })]);
    expect(await stripe.getDefaultPaymentMethodId(customerId)).toBe(cards[0]!.id);
    await expect(card.getCard('sim-replace')).resolves.toMatchObject({
      hasCard: true,
      last4: '4242',
    });
    const inReview = await seedInReviewInvoice('sim-replace');
    const inv = await commission.finalizeInvoice(inReview.id);
    await provider.deliverPendingEvents();
    expect((await commission.getById(inv.id)).status).toBe('paid');
    expect(await auditTypes('sim-replace')).toEqual(
      expect.arrayContaining([
        'setup_intent.succeeded',
        'payment_method.default_set',
        'payment_method.replaced',
      ]),
    );
  });

  it('removing the card is blocked by an unpaid card invoice, and allowed without one', async () => {
    await saveCard('sim-remove-blocked', CARD.ok);
    await seedInReviewInvoice('sim-remove-blocked');
    await expect(card.removeCard('sim-remove-blocked')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
    await expect(card.getCard('sim-remove-blocked')).resolves.toMatchObject({ hasCard: true });

    await saveCard('sim-remove', CARD.ok);
    await expect(card.removeCard('sim-remove')).resolves.toEqual({ hasCard: false });
    await expect(card.getCard('sim-remove')).resolves.toEqual({ hasCard: false });
    await provider.deliverPendingEvents();
    expect((await processedEvents('payment_method.detached')).length).toBeGreaterThan(0);
    expect(await auditTypes('sim-remove')).toEqual(
      expect.arrayContaining(['payment_method.removed', 'payment_method.detached']),
    );
  });

  // ── AC2: one test per event type, through the production handler ────

  it('payment_intent.succeeded is processed by the handler', async () => {
    expect((await processedEvents('payment_intent.succeeded')).length).toBeGreaterThan(0);
  });

  it('payment_intent.payment_failed is processed by the handler', async () => {
    expect((await processedEvents('payment_intent.payment_failed')).length).toBeGreaterThan(0);
  });

  it('payment_method.attached is processed and audited for the tenant', async () => {
    await saveCard('sim-attach', CARD.ok);
    expect((await processedEvents('payment_method.attached')).length).toBeGreaterThan(0);
    expect(await auditTypes('sim-attach')).toContain('payment_method.attached');
  });

  it('invoice.payment_succeeded + customer.subscription.updated/deleted are processed', async () => {
    await saveCard('sim-sub', CARD.ok);
    const customerId = (await stripe.getCustomerId('sim-sub'))!;
    const sub = await stripe.createSubscription({ customerId, priceId: 'price_sim' });
    await stripe.cancelSubscription(sub.id);
    await provider.deliverPendingEvents();
    const audits = await auditTypes('sim-sub');
    expect(audits).toContain('invoice.payment_succeeded');
    expect(audits).toContain('customer.subscription.updated');
    expect(audits).toContain('customer.subscription.deleted');
  });

  it('invoice.payment_failed is processed (flat-plan dunning)', async () => {
    await saveCard('sim-sub-fail', CARD.noFunds);
    const customerId = (await stripe.getCustomerId('sim-sub-fail'))!;
    await stripe.createSubscription({ customerId, priceId: 'price_sim' });
    await provider.deliverPendingEvents();
    expect(await auditTypes('sim-sub-fail')).toContain('invoice.payment_failed');
  });

  it('charge.refunded (admin dashboard refund, partial) reaches the handler', async () => {
    const inv = await chargedInvoice('sim-refund', CARD.ok);
    await provider.deliverPendingEvents();
    const res = await devService.fireInvoiceEvent(inv.id, 'refund', 1_000);
    expect(res.eventType).toBe('charge.refunded');
    expect((await processedEvents('charge.refunded')).length).toBe(1);
  });

  it('charge.dispute.created (admin fired dispute) reaches the handler', async () => {
    const inv = await chargedInvoice('sim-dispute', CARD.ok);
    await provider.deliverPendingEvents();
    const res = await devService.fireInvoiceEvent(inv.id, 'dispute');
    expect(res.eventType).toBe('charge.dispute.created');
    expect((await processedEvents('charge.dispute.created')).length).toBe(1);
  });

  it('redelivering a processed simulated event is a duplicate no-op', async () => {
    const [row] = await processedEvents('payment_intent.succeeded');
    const before = (await testDb.db.select().from(billingEvents)).length;
    // Mark undelivered and flush again: the handler's idempotency holds.
    await testDb.exec(
      `update simulated_payment_objects set delivered_at = null where id = '${row!.eventId}'`,
    );
    expect(await provider.deliverPendingEvents()).toBe(1);
    expect((await testDb.db.select().from(billingEvents)).length).toBe(before);
  });

  // ── Dev service guards ────────────────────────────────────────────────

  it('another tenant cannot confirm or authenticate my intents (404)', async () => {
    const { setupIntentId } = await saveCard('sim-owner', CARD.ok);
    await seedTenant('sim-intruder');
    await card.ensureCustomer('sim-intruder');
    await expect(
      devService.confirmSetup('sim-intruder', setupIntentId, CARD.ok),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      devService.authenticate('sim-intruder', setupIntentId, 'complete'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('firing an event on an uncharged invoice is a 409', async () => {
    await saveCard('sim-uncharged', CARD.ok);
    const inReview = await seedInReviewInvoice('sim-uncharged');
    await expect(devService.fireInvoiceEvent(inReview.id, 'dispute')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('every dev action is a 404 when the Stripe provider is active', async () => {
    const off = createSimulatedPaymentsService({
      provider: null,
      stripe,
      commission,
      audit: createBillingAuditService({ db: testDb.db }),
    });
    expect(off.enabled).toBe(false);
    await expect(off.confirmSetup('t', 'seti_x', CARD.ok)).rejects.toMatchObject({ status: 404 });
    await expect(off.authenticate('t', 'pi_x', 'complete')).rejects.toMatchObject({ status: 404 });
    await expect(off.fireInvoiceEvent(nextId(), 'refund')).rejects.toMatchObject({ status: 404 });
  });
});
