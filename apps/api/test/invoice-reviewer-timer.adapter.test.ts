/**
 * invoice-reviewer-timer adapter test (billing/02).
 *
 * Regression for the Sep 2026 silent-failure class (the sheets-sync-timer
 * incident, fixed in PR #217): a timer that fires but dies on its first
 * DB operation presents from the outside as "never fired" — no run rows,
 * no work done, and the error visible only in App Insights.
 *
 * Unlike the service unit tests (which fake nothing but still call the
 * service directly), this test runs the REAL adapter entry point with the
 * REAL invoice-reviewer service + REAL Drizzle commission/audit stores
 * against PGlite with the real migrations applied — so the exact DB
 * operations a silent failure would kill (the `findDueReviews` SELECT,
 * the per-invoice UPDATEs, and the cycle-completed `billing_events`
 * INSERT) are exercised end to end. Stripe and email stay faked: they are
 * external, not DB.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { createAttributionService } from '../src/services/billing/attribution.service';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import {
  billingEvents,
  commissionInvoices,
  estimates,
  leads,
  tenants,
} from '../src/db/schema';
import type { BillingConfig } from '../src/config';
import { createTestDb, type TestDb } from './pglite-db';

// The adapter binds `createComposition` lazily via getApp(), but the module
// import itself must see the mocked barrel — same pattern as the
// sheets-sync timer adapter test.
const fakeApp: { invoiceReviewerService: unknown } = {
  invoiceReviewerService: null,
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

// Imported after the mock.
import { invoiceReviewerTimerHandler } from '../src/functions/invoice-reviewer-timer';

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

let idCounter = 9000;
function nextId(): string {
  return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
}

let piCounter = 900;
function nextPiId(): string {
  return `pi_reviewer_adapter_${++piCounter}`;
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
    refundPaymentIntent: async (paymentIntentId) => ({
      id: 're_test',
      status: 'succeeded',
    }),
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

/**
 * The timer handler runs `runReviewCycle(new Date())` with the REAL clock,
 * so seeded invoices must already be due against it: the commission
 * service's injected clock is fixed in the past, giving a reviewDueAt long
 * before today.
 */
function newRealService(testDb: TestDb, stripe: StripeService): {
  reviewer: InvoiceReviewerService;
  commission: CommissionService;
} {
  const pastClock = () => new Date('2020-01-01T12:00:00.000Z');
  const attribution = createAttributionService({
    db: testDb.db,
    billing: BILLING,
    now: pastClock,
    newId: nextId,
  });
  const audit: BillingAuditService = createBillingAuditService({
    db: testDb.db,
    newId: nextId,
  });
  const commission = createCommissionService({
    db: testDb.db,
    billing: BILLING,
    attribution,
    audit,
    stripe,
    email: fakeEmail(),
    opsInbox: 'ops@example.com',
    now: pastClock,
    newId: nextId,
  });
  return {
    reviewer: createInvoiceReviewerService({
      billing: BILLING,
      commission,
      audit,
    }),
    commission,
  };
}

let tenantCounter = 0;
async function seedDueInvoice(
  testDb: TestDb,
  commission: CommissionService,
  contractValueCents: number,
): Promise<string> {
  tenantCounter += 1;
  const tenantKey = `reviewer-adapter-builder-${tenantCounter}`;
  await testDb.db.insert(tenants).values({
    tenantKey,
    businessName: `Reviewer Adapter Builder ${tenantCounter}`,
    displayName: `Reviewer Adapter ${tenantCounter}`,
    accentColor: '#B08D57',
    allowedOrigins: ['https://example.com'],
    stripeCustomerId: 'cus_test_123',
  });
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: `reviewer-adapter-st-${tenantCounter}`,
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  const leadId = randomUUID();
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: `reviewer-adapter-st-${tenantCounter}`,
    email: `reviewer-adapter${tenantCounter}@example.com`,
    name: 'Reviewer Adapter Homeowner',
    timeline: '6-12 months',
    consentTs: new Date('2026-03-01T09:00:00Z'),
  });
  // The attribution service is real here too: its DB reads are part of the
  // path the timer exercises. Only the clock-dependent part (submitForReview)
  // uses the past clock so the invoice is due against the real `new Date()`
  // the handler passes in.
  const attribution = createAttributionService({
    db: testDb.db,
    billing: BILLING,
    now: () => new Date('2020-01-01T12:00:00.000Z'),
    newId: nextId,
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

function makeContext() {
  const logs: unknown[][] = [];
  return {
    logs,
    context: { log: (...args: unknown[]) => void logs.push(args) },
    lines: () => logs.map((args) => String(args[0])),
  };
}

describe('invoice-reviewer-timer adapter', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('finalizes a due invoice through the real handler and logs aggregate counts only', async () => {
    const { reviewer, commission } = newRealService(testDb, fakeStripe());
    const invoiceId = await seedDueInvoice(testDb, commission, 50_000_000);
    fakeApp.invoiceReviewerService = reviewer;

    const { context, lines } = makeContext();

    // Must not throw: the Sep 2026 sheets-sync incident was exactly this
    // call dying on its first DB write, leaving zero trace.
    await expect(invoiceReviewerTimerHandler(context)).resolves.toBeUndefined();

    const invoice = await commission.getById(invoiceId);
    expect(invoice.status).toBe('finalized');
    expect(invoice.stripePaymentIntentId).toMatch(/^pi_reviewer_adapter_/);

    // The cycle-completed audit row — the last DB write of the cycle —
    // landed too.
    const cycleRows = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.eventType, 'reviewer.cycle_completed'));
    expect(cycleRows.length).toBeGreaterThanOrEqual(1);
    const latest = cycleRows[cycleRows.length - 1]!;
    expect((latest.payload as Record<string, unknown>)?.finalized).toBe(1);

    const line = lines()[0]!;
    expect(line).toContain('cycle complete');
    expect(line).toContain('finalized=1');
    expect(line).toContain('failed=0');
    // No tenant keys, invoice ids, emails, or amounts in the log line.
    expect(line).not.toMatch(/@/);
    expect(line).not.toMatch(/reviewer-adapter-builder-/);
    expect(line).not.toMatch(/pi_reviewer_adapter_/);
  });

  it('one failing invoice does not kill the batch through the handler', async () => {
    // The $50,000 contract → $500,000 commission will fail Stripe; the
    // $30,000 one succeeds.
    const { reviewer, commission } = newRealService(
      testDb,
      fakeStripe(500_000),
    );
    const failingId = await seedDueInvoice(testDb, commission, 50_000_000);
    const okId = await seedDueInvoice(testDb, commission, 30_000_000);
    fakeApp.invoiceReviewerService = reviewer;

    const { context, lines } = makeContext();
    await expect(invoiceReviewerTimerHandler(context)).resolves.toBeUndefined();

    expect((await commission.getById(okId)).status).toBe('finalized');
    expect((await commission.getById(failingId)).status).toBe('in_review');

    const all = lines().join('\n');
    expect(all).toContain('finalized=1');
    expect(all).toContain('failed=1');
    expect(all).toContain('invoice failed: card declined (simulated)');
  });

  /**
   * The "silently broken" guard: if the cycle dies on a top-level DB
   * operation (the Sep 2026 sheets-sync class — e.g. the
   * `commission_invoices` SELECT or the cycle-completed `billing_events`
   * INSERT failing on schema drift), the adapter emits a structured,
   * sanitized failure line for Azure Monitor to alert on, then rethrows so
   * the host records the invocation failure and retries on schedule.
   */
  it('logs a structured CYCLE FAILED line and rethrows when the cycle throws', async () => {
    const boom = new Error('insert into "commission_invoices" failed: boom');
    fakeApp.invoiceReviewerService = {
      runReviewCycle: vi.fn().mockRejectedValue(boom),
    };

    const { context, lines } = makeContext();
    await expect(invoiceReviewerTimerHandler(context)).rejects.toThrow('boom');

    const line = lines()[0]!;
    expect(line).toContain('CYCLE FAILED');
    expect(line).toContain('boom');
  });
});
