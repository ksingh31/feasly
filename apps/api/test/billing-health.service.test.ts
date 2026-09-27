/**
 * Billing-health service tests (billing/03 follow-on — /admin/billing).
 *
 * Runs against PGlite with the real migration SQL. Stripe is a fake (only
 * the isConfigured/testMode flags are read — the dashboard never calls the
 * Stripe SDK). Covers:
 * - in-review aging buckets (<48h / <7d / overdue)
 * - dunning rows with past_due_since from the invoice.charge_failed audit
 *   row, falling back to updatedAt
 * - MRR: null under commission; active-subscription sum under flat
 * - trailing-30d collections
 * - webhook health panel (24h window, by-type, unhandled/model-mismatch)
 * - read-only: the service issues no mutations
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createBillingHealthService,
  type BillingHealthService,
} from '../src/services/billing/billing-health.service';
import type { BillingConfig } from '../src/config';
import type { StripeService } from '../src/services/billing/stripe.service';
import {
  attributionEvents,
  billingEvents,
  commissionInvoices,
  estimates,
  leads,
  stripeEvents,
  tenants,
} from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const FIXED_NOW = new Date('2026-09-26T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(h: number): Date {
  return new Date(FIXED_NOW.getTime() - h * HOUR_MS);
}

function makeBilling(model: 'commission' | 'flat'): BillingConfig {
  return {
    model,
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
}

const fakeStripe: StripeService = {
  isConfigured: true,
  testMode: true,
  createCustomer: async () => ({ id: 'cus_test_123' }),
  createSetupIntent: async () => ({
    id: 'seti_test_123',
    clientSecret: 'seti_test_secret',
  }),
  createOffSessionPaymentIntent: async () => ({
    id: 'pi_test_123',
    status: 'requires_capture',
  }),
  createSubscription: async () => ({ id: 'sub_test_123', status: 'active' }),
  cancelSubscription: async (subscriptionId) => ({ id: subscriptionId }),
  verifyWebhook: () => ({
    id: 'evt_test',
    type: 'payment_intent.succeeded',
  }),
  saveCustomerId: async () => {},
  getCustomerId: async () => null,
  getTenantKeyByCustomerId: async () => null,
};

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);

afterAll(async () => {
  await testDb.close();
});

function makeService(model: 'commission' | 'flat'): BillingHealthService {
  return createBillingHealthService({
    db: testDb.db,
    billing: makeBilling(model),
    stripe: fakeStripe,
    now: () => FIXED_NOW,
  });
}

async function seedParents(): Promise<{
  attributionId: string;
  leadId: string;
}> {
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: 'billing-health-test-calgary',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.3.0',
  });
  const leadId = randomUUID();
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: 'billing-health-test-calgary',
    email: 'homeowner@example.com',
    name: 'Test Homeowner',
    timeline: '3-6 months',
    consentTs: hoursAgo(100),
  });
  const attributionId = randomUUID();
  await testDb.db.insert(attributionEvents).values({
    id: attributionId,
    leadId,
    tenantKey: 'test-builder',
    introducedAt: hoursAgo(200),
  });
  return { attributionId, leadId };
}

async function seedTenant(): Promise<void> {
  await testDb.db.insert(tenants).values({
    tenantKey: 'test-builder',
    businessName: 'Test Builder Inc',
    displayName: 'Test Builder',
    accentColor: '#B08D57',
    allowedOrigins: ['https://test-builder.example'],
  });
}

interface SeedInvoice {
  status: 'draft' | 'in_review' | 'finalized' | 'paid' | 'failed' | 'disputed' | 'void';
  commissionCents: number;
  createdAt: Date;
  reviewDueAt?: Date | null;
  paidAt?: Date | null;
  updatedAt?: Date;
}

async function seedInvoice(
  parents: { attributionId: string; leadId: string },
  seed: SeedInvoice,
): Promise<string> {
  const id = randomUUID();
  await testDb.db.insert(commissionInvoices).values({
    id,
    tenantKey: 'test-builder',
    attributionId: parents.attributionId,
    leadId: parents.leadId,
    contractValueCents: seed.commissionCents * 100,
    commissionCents: seed.commissionCents,
    currency: 'CAD',
    status: seed.status,
    reviewDueAt: seed.reviewDueAt ?? null,
    paidAt: seed.paidAt ?? null,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt ?? seed.createdAt,
  });
  return id;
}

async function seedAudit(input: {
  tenantKey: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
  createdAt: Date;
}): Promise<void> {
  await testDb.db.insert(billingEvents).values({
    id: randomUUID(),
    tenantKey: input.tenantKey,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload ?? null,
    createdAt: input.createdAt,
  });
}

describe('billing-health service', () => {
  it('buckets in-review invoices by age (<48h / <7d / overdue)', async () => {
    await seedTenant();
    const parents = await seedParents();
    // Fresh: created 10h ago, window still open.
    await seedInvoice(parents, {
      status: 'in_review',
      commissionCents: 10_000,
      createdAt: hoursAgo(10),
      reviewDueAt: new Date(FIXED_NOW.getTime() + 6 * 24 * HOUR_MS),
    });
    // Aging: created 3 days ago, window still open.
    await seedInvoice(parents, {
      status: 'in_review',
      commissionCents: 20_000,
      createdAt: hoursAgo(72),
      reviewDueAt: new Date(FIXED_NOW.getTime() + 4 * 24 * HOUR_MS),
    });
    // Overdue: review window passed.
    await seedInvoice(parents, {
      status: 'in_review',
      commissionCents: 30_000,
      createdAt: hoursAgo(200),
      reviewDueAt: hoursAgo(2),
    });

    const health = await makeService('commission').getHealth();

    expect(health.inReview.under48h).toEqual({
      count: 1,
      commissionCents: 10_000,
    });
    expect(health.inReview.under7d).toEqual({
      count: 1,
      commissionCents: 20_000,
    });
    expect(health.inReview.overdue).toEqual({
      count: 1,
      commissionCents: 30_000,
    });
  });

  it('reports dunning invoices with past_due_since from the charge_failed audit row', async () => {
    const parents = await seedParents();
    const failedAt = hoursAgo(30);
    const failedId = await seedInvoice(parents, {
      status: 'failed',
      commissionCents: 15_000,
      createdAt: hoursAgo(100),
      updatedAt: hoursAgo(29),
    });
    await seedAudit({
      tenantKey: 'test-builder',
      eventType: 'invoice.charge_failed',
      entityType: 'commission_invoice',
      entityId: failedId,
      payload: { paymentIntentId: 'pi_test_1' },
      createdAt: failedAt,
    });
    // No audit row → falls back to updatedAt.
    const legacyFailedAt = hoursAgo(50);
    await seedInvoice(parents, {
      status: 'failed',
      commissionCents: 5_000,
      createdAt: hoursAgo(120),
      updatedAt: legacyFailedAt,
    });

    const health = await makeService('commission').getHealth();

    expect(health.dunning).toHaveLength(2);
    // Oldest past-due first.
    expect(health.dunning[0]).toMatchObject({
      id: expect.any(String),
      tenantKey: 'test-builder',
      commissionCents: 5_000,
      currency: 'CAD',
      pastDueSince: legacyFailedAt.toISOString(),
    });
    expect(health.dunning[1]).toMatchObject({
      id: failedId,
      commissionCents: 15_000,
      pastDueSince: failedAt.toISOString(),
    });
  });

  it('reports MRR as null under commission and sums active subscriptions under flat', async () => {
    const commissionHealth = await makeService('commission').getHealth();
    expect(commissionHealth.model).toBe('commission');
    expect(commissionHealth.mrr).toEqual({
      cents: null,
      currency: 'CAD',
      activeSubscriptions: 0,
      source: 'not_applicable',
    });

    // Flat: two subscriptions created, one cancelled.
    await seedAudit({
      tenantKey: 'test-builder',
      eventType: 'subscription.created',
      entityType: 'stripe_subscription',
      entityId: 'sub_active_1',
      payload: { monthlyCents: 30_000, currency: 'CAD' },
      createdAt: hoursAgo(400),
    });
    await seedAudit({
      tenantKey: 'test-builder',
      eventType: 'subscription.created',
      entityType: 'stripe_subscription',
      entityId: 'sub_cancelled_1',
      payload: { monthlyCents: 30_000, currency: 'CAD' },
      createdAt: hoursAgo(300),
    });
    await seedAudit({
      tenantKey: 'test-builder',
      eventType: 'subscription.cancelled',
      entityType: 'stripe_subscription',
      entityId: 'sub_cancelled_1',
      createdAt: hoursAgo(100),
    });

    const flatHealth = await makeService('flat').getHealth();
    expect(flatHealth.model).toBe('flat');
    expect(flatHealth.mrr).toEqual({
      cents: 30_000,
      currency: 'CAD',
      activeSubscriptions: 1,
      source: 'stripe',
    });
  });

  it('counts trailing-30d collections and the disputed bucket', async () => {
    const parents = await seedParents();
    await seedInvoice(parents, {
      status: 'paid',
      commissionCents: 40_000,
      createdAt: hoursAgo(200),
      paidAt: hoursAgo(120), // 5 days ago — inside the window.
    });
    await seedInvoice(parents, {
      status: 'paid',
      commissionCents: 60_000,
      createdAt: hoursAgo(1000),
      paidAt: hoursAgo(960), // 40 days ago — outside the window.
    });
    await seedInvoice(parents, {
      status: 'disputed',
      commissionCents: 25_000,
      createdAt: hoursAgo(50),
    });

    const health = await makeService('commission').getHealth();

    expect(health.collectedTrailing30d).toEqual({
      count: 1,
      commissionCents: 40_000,
    });
    expect(health.disputed).toEqual({ count: 1, commissionCents: 25_000 });
  });

  it('reports webhook health over the trailing 24h', async () => {
    await testDb.db.insert(stripeEvents).values([
      { eventId: 'evt_recent_1', type: 'payment_intent.succeeded', receivedAt: hoursAgo(2) },
      { eventId: 'evt_recent_2', type: 'payment_intent.succeeded', receivedAt: hoursAgo(5) },
      { eventId: 'evt_recent_3', type: 'invoice.payment_failed', receivedAt: hoursAgo(20) },
      // Outside the 24h window — excluded.
      { eventId: 'evt_old_1', type: 'payment_intent.succeeded', receivedAt: hoursAgo(30) },
    ]);
    await seedAudit({
      tenantKey: null,
      eventType: 'webhook.unhandled',
      entityType: 'stripe_event',
      entityId: 'evt_weird_1',
      createdAt: hoursAgo(3),
    });
    await seedAudit({
      tenantKey: null,
      eventType: 'webhook.model_mismatch',
      entityType: 'stripe_event',
      entityId: 'evt_mm_1',
      createdAt: hoursAgo(4),
    });

    const health = await makeService('commission').getHealth();

    expect(health.webhooks.received24h).toBe(3);
    expect(health.webhooks.lastReceivedAt).toBe(hoursAgo(2).toISOString());
    expect(health.webhooks.byType24h).toEqual([
      { type: 'payment_intent.succeeded', count: 2 },
      { type: 'invoice.payment_failed', count: 1 },
    ]);
    expect(health.webhooks.unhandled24h).toBe(1);
    expect(health.webhooks.modelMismatch24h).toBe(1);
  });

  it('passes through Stripe config flags and a generation timestamp', async () => {
    const health = await makeService('commission').getHealth();
    expect(health.stripe).toEqual({ configured: true, testMode: true });
    expect(health.generatedAt).toBe(FIXED_NOW.toISOString());
  });
});
