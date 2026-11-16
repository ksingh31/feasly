/**
 * Invoice reviewer timer tests (billing/02).
 *
 * The daily timer finalizes in-review invoices whose 7-day window has
 * passed. Covers: due invoices get finalized, not-yet-due are skipped,
 * one failure doesn't stop the batch, disputed invoices are never
 * auto-finalized, and the cycle is a no-op under BILLING_MODEL=flat.
 * #711: stuck 'finalized' invoices are reconciled from the PaymentIntent's
 * real Stripe status.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createInvoiceReviewerService,
  type InvoiceReviewerService,
} from '../src/services/billing/invoice-reviewer.service';
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
import type {
  PaymentIntentStatus,
  StripeService,
} from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import {
  billingEvents,
  estimates,
  leads,
  tenants,
  builders,
} from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

import type { BillingConfig } from '../src/config';
import { BUILDER_STATUSES, BUILDER_STATUS_POLICY } from '@feasly/contracts';

const BILLING: BillingConfig = {
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

let idCounter = 5000;
function nextId(): string {
  return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
}

let piCounter = 500;
function nextPiId(): string {
  return `pi_reviewer_${++piCounter}`;
}

function fakeStripe(
  failOnAmount?: number,
  retrieve: (id: string) => Promise<PaymentIntentStatus> = async (id) => ({
    id,
    status: 'processing',
  }),
): StripeService {
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
    createSetupIntent: async () => ({ id: 'seti_test', clientSecret: 's' }),
    listPaymentMethods: async () => [],
    createOffSessionPaymentIntent: async (input) => {
      if (failOnAmount !== undefined && input.amountCents === failOnAmount) {
        throw new Error('card declined (simulated)');
      }
      return { id: nextPiId(), status: 'requires_capture' };
    },
    createSubscription: async () => ({ id: 'sub_test', status: 'active' }),
    cancelSubscription: async (id) => ({ id }),
    retrievePaymentIntent: retrieve,
    getPaymentIntentConfirmation: async (id: string) => ({ id, status: 'requires_action', clientSecret: `${id}_secret_test` }),
    findRefundByMetadata: async () => null,
    refundPaymentIntent: async (paymentIntentId) => ({ id: 're_test', status: 'succeeded' }),
    verifyWebhook: () => {
      throw new Error('not used');
    },
    getCustomerId: async () => 'cus_test_123',
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
  };
}

function fakeEmail(): EmailService {
  const noop = async () => ({ sent: true, provider: 'log' as const });
  return {
    sendMagicLink: noop,
    sendPartnerShare: noop,
    sendCallbackConfirmation: noop,
    sendNudge: noop,
    sendFollowUp: noop,
    sendOpsAlert: noop,
  } as unknown as EmailService;
}

interface Fixtures {
  reviewer: InvoiceReviewerService;
  commission: CommissionService;
  attribution: AttributionService;
}

function newFixtures(
  testDb: TestDb,
  stripe: StripeService,
  billing = BILLING,
  builderStatus?: (tenantKey: string) => Promise<string | null>,
): Fixtures {
  const email = fakeEmail();
  const attribution = createAttributionService({
    db: testDb.db,
    billing,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    newId: nextId,
  });
  const audit: BillingAuditService = createBillingAuditService({
    db: testDb.db,
    newId: nextId,
  });
  const commission = createCommissionService({
    db: testDb.db,
    billing,
    attribution,
    audit,
    stripe,
    email,
    opsInbox: 'ops@example.com',
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    newId: nextId,
  });
  const reviewer = createInvoiceReviewerService({
    billing,
    commission,
    audit,
    stripe,
    ...(builderStatus ? { builderStatus } : {}),
  });
  return { reviewer, commission, attribution };
}

let tenantCounter = 0;
async function seedInvoice(
  testDb: TestDb,
  attribution: AttributionService,
  commission: CommissionService,
  contractValueCents: number,
  // billing/12: when set, the builder's default payment method is seeded
  // BEFORE invoice creation so the invoice inherits it.
  defaultPaymentMethod?: 'cheque' | 'e_transfer' | 'bank_draft',
): Promise<string> {
  tenantCounter += 1;
  const tenantKey = `reviewer-builder-${tenantCounter}`;
  await testDb.db.insert(tenants).values({
    tenantKey,
    businessName: `Reviewer Builder ${tenantCounter}`,
    displayName: `Reviewer ${tenantCounter}`,
    accentColor: '#B08D57',
    allowedOrigins: ['https://example.com'],
    stripeCustomerId: 'cus_test_123',
  });
  if (defaultPaymentMethod !== undefined) {
    await testDb.db.insert(builders).values({
      id: randomUUID(),
      tenantKey,
      businessName: `Reviewer Builder ${tenantCounter}`,
      displayName: `Reviewer ${tenantCounter}`,
      settings: { defaultPaymentMethod },
    });
  }
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: `reviewer-st-${tenantCounter}`,
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  const leadId = randomUUID();
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: `reviewer-st-${tenantCounter}`,
    email: `reviewer${tenantCounter}@example.com`,
    name: 'Reviewer Homeowner',
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
    contractValueCents,
    contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
    reportedAt: new Date('2026-06-05T10:00:00.000Z'),
  });
  const draft = await commission.createDraftInvoice(reported.id);
  const inReview = await commission.submitForReview(draft.id);
  return inReview.id;
}

describe('invoice reviewer timer', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterEach(async () => {
    await testDb.close();
  });

  it('finalizes in-review invoices whose window has passed', async () => {
    const { reviewer, commission, attribution } = newFixtures(
      testDb,
      fakeStripe(),
    );
    const invoiceId = await seedInvoice(testDb, attribution, commission, 50_000_000);

    // Review due 2026-10-01; run the timer after that.
    const result = await reviewer.runReviewCycle(
      new Date('2026-10-02T00:00:00.000Z'),
    );

    expect(result.finalized).toBe(1);
    expect(result.failed).toBe(0);
    const invoice = await commission.getById(invoiceId);
    expect(invoice.status).toBe('finalized');
    expect(invoice.stripePaymentIntentId).toMatch(/^pi_reviewer_/);
  });

  // #860: auto-charge enforcement point — one test per builder status.
  it.each(BUILDER_STATUSES)('a %s builder\'s due invoice follows the autoCharge policy', async (status) => {
    const { reviewer, commission, attribution } = newFixtures(
      testDb,
      fakeStripe(),
      BILLING,
      async () => status,
    );
    const invoiceId = await seedInvoice(testDb, attribution, commission, 50_000_000);
    const result = await reviewer.runReviewCycle(new Date('2026-10-02T00:00:00.000Z'));
    const invoice = await commission.getById(invoiceId);
    if (BUILDER_STATUS_POLICY[status].autoCharge) {
      expect(result.finalized).toBe(1);
      expect(invoice.status).toBe('finalized');
    } else {
      expect(result.finalized).toBe(0);
      expect(result.skipped).toBe(1);
      expect(invoice.status).toBe('in_review');
      expect(invoice.stripePaymentIntentId).toBeNull();
    }
  });

  it('skips invoices whose review window has not passed yet', async () => {
    const { reviewer, commission, attribution } = newFixtures(
      testDb,
      fakeStripe(),
    );
    const invoiceId = await seedInvoice(testDb, attribution, commission, 30_000_000);

    // Run the timer BEFORE the review is due.
    const result = await reviewer.runReviewCycle(
      new Date('2026-09-25T00:00:00.000Z'),
    );

    expect(result.finalized).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(0);
    const invoice = await commission.getById(invoiceId);
    expect(invoice.status).toBe('in_review');
  });

  it('one failed invoice does not stop the batch', async () => {
    // The $50,000 contract → $500,000 commission will fail; the $30,000 one succeeds.
    const stripe = fakeStripe(500_000);
    const { reviewer, commission, attribution } = newFixtures(testDb, stripe);
    const failingId = await seedInvoice(
      testDb,
      attribution,
      commission,
      50_000_000,
    );
    const okId = await seedInvoice(testDb, attribution, commission, 30_000_000);

    const result = await reviewer.runReviewCycle(
      new Date('2026-10-02T00:00:00.000Z'),
    );

    expect(result.finalized).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
    // The good invoice still got finalized.
    expect((await commission.getById(okId)).status).toBe('finalized');
    // The failing one stays in review for the next cycle.
    expect((await commission.getById(failingId)).status).toBe('in_review');
  });

  it('never auto-finalizes a disputed invoice', async () => {
    const { reviewer, commission, attribution } = newFixtures(
      testDb,
      fakeStripe(),
    );
    const invoiceId = await seedInvoice(testDb, attribution, commission, 20_000_000);
    await commission.disputeInvoice(invoiceId, 'prior relationship claim');

    const result = await reviewer.runReviewCycle(
      new Date('2026-10-02T00:00:00.000Z'),
    );

    // The disputed invoice is not in the due set, so nothing was finalized.
    const invoice = await commission.getById(invoiceId);
    expect(invoice.status).toBe('disputed');
    expect(result.finalized).toBe(0);
  });

  it('skips manual-method invoices (billing/12) and reports them as skipped', async () => {
    const { reviewer, commission, attribution } = newFixtures(
      testDb,
      fakeStripe(),
    );
    const manualId = await seedInvoice(
      testDb,
      attribution,
      commission,
      40_000_000,
      'cheque',
    );
    const cardId = await seedInvoice(testDb, attribution, commission, 30_000_000);

    const result = await reviewer.runReviewCycle(
      new Date('2026-10-02T00:00:00.000Z'),
    );

    // The card invoice charged; the manual one was skipped, not failed.
    expect(result.finalized).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect((await commission.getById(manualId)).status).toBe('in_review');
    expect((await commission.getById(cardId)).status).toBe('finalized');
  });

  it('is a no-op under BILLING_MODEL=flat', async () => {
    const flatBilling = { ...BILLING, model: 'flat' as const };
    const { reviewer } = newFixtures(testDb, fakeStripe(), flatBilling);

    const result = await reviewer.runReviewCycle(
      new Date('2026-10-02T00:00:00.000Z'),
    );

    expect(result).toEqual({
      finalized: 0,
      skipped: 0,
      failed: 0,
      reconciledPaid: 0,
      reconciledFailed: 0,
      stillPending: 0,
      retried: 0,
      overdueReminded: 0,
      errors: [],
    });
  });

  describe('settlement reconciliation (#711)', () => {
    // The commission clock is fixed at 2026-09-24T12:00Z, so an invoice
    // finalized by the first cycle entered 'finalized' then. A second cycle
    // a week later is far past the 24h threshold.
    const FIRST_CYCLE = new Date('2026-10-02T00:00:00.000Z');
    const SECOND_CYCLE = new Date('2026-10-03T00:00:00.000Z');

    async function settlementRows(testDb: TestDb, invoiceId: string) {
      const rows = await testDb.db.select().from(billingEvents);
      return rows.filter(
        (r) =>
          r.entityId === invoiceId &&
          (r.eventType === 'invoice.charge_succeeded' ||
            r.eventType === 'invoice.charge_failed'),
      );
    }

    it('settles a stuck finalized invoice paid from a succeeded PaymentIntent', async () => {
      const statuses = new Map<string, string>();
      const retrieved: string[] = [];
      const stripe = fakeStripe(undefined, async (id) => {
        retrieved.push(id);
        return { id, status: statuses.get(id) ?? 'processing' };
      });
      const { reviewer, commission, attribution } = newFixtures(testDb, stripe);
      const invoiceId = await seedInvoice(testDb, attribution, commission, 50_000_000);

      const first = await reviewer.runReviewCycle(FIRST_CYCLE);
      expect(first.finalized).toBe(1);
      // Just finalized this cycle → never reconciled in the same cycle.
      expect(retrieved).toEqual([]);

      const piId = (await commission.getById(invoiceId)).stripePaymentIntentId!;
      statuses.set(piId, 'succeeded');
      const second = await reviewer.runReviewCycle(SECOND_CYCLE);

      expect(second.reconciledPaid).toBe(1);
      expect(second.reconciledFailed).toBe(0);
      expect(second.stillPending).toBe(0);
      expect(retrieved).toEqual([piId]);
      expect((await commission.getById(invoiceId)).status).toBe('paid');
      const rows = await settlementRows(testDb, invoiceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({
        paymentIntentId: piId,
        source: 'reconciliation',
      });

      // A later cycle has nothing left to reconcile.
      const third = await reviewer.runReviewCycle(
        new Date('2026-10-04T00:00:00.000Z'),
      );
      expect(third.reconciledPaid).toBe(0);
      expect(await settlementRows(testDb, invoiceId)).toHaveLength(1);
    });

    it('settles a stuck invoice failed from a declined PaymentIntent, with the reason', async () => {
      const stripe = fakeStripe(undefined, async (id) => ({
        id,
        status: 'requires_payment_method',
        lastPaymentErrorMessage: 'Your card was declined.',
      }));
      const { reviewer, commission, attribution } = newFixtures(testDb, stripe);
      const invoiceId = await seedInvoice(testDb, attribution, commission, 30_000_000);
      await reviewer.runReviewCycle(FIRST_CYCLE);

      const second = await reviewer.runReviewCycle(SECOND_CYCLE);

      expect(second.reconciledFailed).toBe(1);
      expect((await commission.getById(invoiceId)).status).toBe('failed');
      const rows = await settlementRows(testDb, invoiceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({
        source: 'reconciliation',
        failureReason: 'Your card was declined.',
      });
    });

    it('moves a stuck invoice to action_required when Stripe reports authentication_required (#712)', async () => {
      // Real Stripe leaves an off-session 3DS demand in
      // requires_payment_method with code authentication_required.
      const stripe = fakeStripe(undefined, async (id) => ({
        id,
        status: 'requires_payment_method',
        lastPaymentErrorMessage: 'This payment requires authentication.',
        lastPaymentErrorCode: 'authentication_required',
      }));
      const { reviewer, commission, attribution } = newFixtures(testDb, stripe);
      const invoiceId = await seedInvoice(testDb, attribution, commission, 30_000_000);
      await reviewer.runReviewCycle(FIRST_CYCLE);

      const second = await reviewer.runReviewCycle(SECOND_CYCLE);

      expect(second.reconciledFailed).toBe(0);
      expect(second.stillPending).toBe(1);
      expect((await commission.getById(invoiceId)).status).toBe('action_required');
      expect(await settlementRows(testDb, invoiceId)).toHaveLength(0);
    });

    it('leaves an in-flight PaymentIntent pending', async () => {
      const { reviewer, commission, attribution } = newFixtures(
        testDb,
        fakeStripe(),
      );
      const invoiceId = await seedInvoice(testDb, attribution, commission, 30_000_000);
      await reviewer.runReviewCycle(FIRST_CYCLE);

      const second = await reviewer.runReviewCycle(SECOND_CYCLE);

      expect(second.stillPending).toBe(1);
      expect(second.reconciledPaid + second.reconciledFailed).toBe(0);
      expect((await commission.getById(invoiceId)).status).toBe('finalized');
    });

    it('does not reconcile an invoice inside the threshold', async () => {
      const retrieved: string[] = [];
      const stripe = fakeStripe(undefined, async (id) => {
        retrieved.push(id);
        return { id, status: 'succeeded' };
      });
      // 30 days: the week-old finalized invoice is not stuck yet.
      const { reviewer, commission, attribution } = newFixtures(testDb, stripe, {
        ...BILLING,
        settlementThresholdHours: 24 * 30,
      });
      const invoiceId = await seedInvoice(testDb, attribution, commission, 30_000_000);
      await reviewer.runReviewCycle(FIRST_CYCLE);

      const second = await reviewer.runReviewCycle(SECOND_CYCLE);

      expect(retrieved).toEqual([]);
      expect(second.stillPending).toBe(0);
      expect((await commission.getById(invoiceId)).status).toBe('finalized');
    });

    it('a Stripe lookup failure on one invoice does not stop the batch', async () => {
      let lookups = 0;
      const stripe = fakeStripe(undefined, async (id) => {
        lookups += 1;
        if (lookups === 1) throw new Error('stripe unavailable (simulated)');
        return { id, status: 'succeeded' };
      });
      const { reviewer, commission, attribution } = newFixtures(testDb, stripe);
      const a = await seedInvoice(testDb, attribution, commission, 30_000_000);
      const b = await seedInvoice(testDb, attribution, commission, 40_000_000);
      await reviewer.runReviewCycle(FIRST_CYCLE);

      const second = await reviewer.runReviewCycle(SECOND_CYCLE);

      // The first lookup throws; the second invoice still settles.
      expect(second.failed).toBe(1);
      expect(second.errors).toHaveLength(1);
      expect(second.reconciledPaid).toBe(1);
      const statuses = [
        (await commission.getById(a)).status,
        (await commission.getById(b)).status,
      ].sort();
      expect(statuses).toEqual(['finalized', 'paid']);
    });
  });
});
