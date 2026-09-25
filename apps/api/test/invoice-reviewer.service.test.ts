/**
 * Invoice reviewer timer tests (billing/02).
 *
 * The daily timer finalizes in-review invoices whose 7-day window has
 * passed. Covers: due invoices get finalized, not-yet-due are skipped,
 * one failure doesn't stop the batch, disputed invoices are never
 * auto-finalized, and the cycle is a no-op under BILLING_MODEL=flat.
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
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import { estimates, leads, tenants } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

import type { BillingConfig } from '../src/config';

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

function fakeStripe(failOnAmount?: number): StripeService {
  return {
    isConfigured: true,
    testMode: true,
    createCustomer: async () => ({ id: 'cus_test' }),
    createSetupIntent: async () => ({ id: 'seti_test', clientSecret: 's' }),
    createOffSessionPaymentIntent: async (input) => {
      if (failOnAmount !== undefined && input.amountCents === failOnAmount) {
        throw new Error('card declined (simulated)');
      }
      return { id: nextPiId(), status: 'requires_capture' };
    },
    createSubscription: async () => ({ id: 'sub_test', status: 'active' }),
    cancelSubscription: async (id) => ({ id }),
    verifyWebhook: () => {
      throw new Error('not used');
    },
    getCustomerId: async () => 'cus_test_123',
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
  };
}

function fakeEmail(): EmailService {
  const noop = async () => ({ sent: true });
  return {
    sendMagicLink: noop,
    sendPartnerShare: noop,
    sendCallbackConfirmation: noop,
    sendNudge: noop,
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
  const reviewer = createInvoiceReviewerService({ billing, commission, audit });
  return { reviewer, commission, attribution };
}

let tenantCounter = 0;
async function seedInvoice(
  testDb: TestDb,
  attribution: AttributionService,
  commission: CommissionService,
  contractValueCents: number,
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

  it('is a no-op under BILLING_MODEL=flat', async () => {
    const flatBilling = { ...BILLING, model: 'flat' as const };
    const { reviewer } = newFixtures(testDb, fakeStripe(), flatBilling);

    const result = await reviewer.runReviewCycle(
      new Date('2026-10-02T00:00:00.000Z'),
    );

    expect(result).toEqual({ finalized: 0, skipped: 0, failed: 0, errors: [] });
  });
});
