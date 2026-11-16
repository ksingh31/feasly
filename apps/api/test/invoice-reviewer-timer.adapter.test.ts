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
  builderMemberships,
  builders,
  cardExpiryReminders,
  commissionInvoices,
  estimates,
  leads,
  tenants,
  users,
} from '../src/db/schema';
import { createCardExpiryReminderService } from '../src/services/billing/card-expiry-reminder.service';
import { createDrizzleCardExpiryReminderStore } from '../src/services/billing/card-expiry-reminder.store';
import { createBuilderService } from '../src/services/builder.service';
import { createDrizzleMembershipStore } from '../src/services/user.store';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import type { CardSummary } from '../src/services/billing/stripe.service';
import type { CardExpiryReminderEmailInput } from '../src/services/email/email.service';
import type { BillingConfig } from '../src/config';
import { createTestDb, type TestDb } from './pglite-db';

// The adapter binds `createComposition` lazily via getApp(), but the module
// import itself must see the mocked barrel — same pattern as the
// sheets-sync timer adapter test.
const fakeApp: {
  invoiceReviewerService: unknown;
  cardExpiryReminderService: unknown;
  commissionService: unknown;
} = {
  invoiceReviewerService: null,
  // #892: the timer also sweeps stale pending refunds; a no-op by default.
  commissionService: {
    sweepStalePendingRefunds: async () => ({
      checked: 0,
      adopted: 0,
      failed: 0,
      unresolved: 0,
      errors: [],
    }),
  },
  // #880: the timer also runs the card reminder; a no-op unless a test
  // installs the real one.
  cardExpiryReminderService: {
    runReminderCycle: async () => ({
      checked: 0,
      reminded: 0,
      emailsSent: 0,
      alreadyReminded: 0,
      skipped: 0,
      errors: [],
    }),
  },
};
const NOOP_REMINDERS = fakeApp.cardExpiryReminderService;
const NOOP_SWEEP = fakeApp.commissionService;

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
  // #880: wide enough that a card expiring at the end of the real current
  // month is always inside the window (the timer uses the real clock).
  cardExpiryWarningDays: 45,
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
    retrievePaymentIntent: async (id: string) => ({ id, status: 'processing' }),
    getPaymentIntentConfirmation: async (id: string) => ({ id, status: 'requires_action', clientSecret: `${id}_secret_test` }),
    findRefundByMetadata: async () => null,
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
      stripe,
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
    const reminders = vi.fn().mockResolvedValue({
      checked: 0,
      reminded: 0,
      emailsSent: 0,
      alreadyReminded: 0,
      skipped: 0,
      errors: [],
    });
    fakeApp.cardExpiryReminderService = { runReminderCycle: reminders };

    const { context, lines } = makeContext();
    await expect(invoiceReviewerTimerHandler(context)).rejects.toThrow('boom');

    const line = lines()[0]!;
    expect(line).toContain('CYCLE FAILED');
    expect(line).toContain('boom');
    // #880: a failed review cycle does not skip the card reminder.
    expect(reminders).toHaveBeenCalledTimes(1);
    fakeApp.cardExpiryReminderService = NOOP_REMINDERS;
  });
});

/**
 * #880 — the one-time card-expiry reminder rides the same daily timer.
 * REAL reminder service + REAL Drizzle stores (dedupe table, tenants,
 * builders, memberships, billing_events) against PGlite with the real
 * migrations; the payment provider and email stay faked (external).
 */
describe('invoice-reviewer-timer adapter — card-expiry reminder (#880)', () => {
  let testDb: TestDb;
  const TENANT = 'card-reminder-builder';
  const CUSTOMER = 'cus_card_reminder';
  let cards: CardSummary[] = [];
  let sends: CardExpiryReminderEmailInput[] = [];

  /** A card valid through the end of the real current month: in window. */
  function expiringCard(id: string, last4: string): CardSummary {
    const now = new Date();
    return {
      id,
      brand: 'visa',
      last4,
      expMonth: now.getUTCMonth() + 1,
      expYear: now.getUTCFullYear(),
    };
  }

  function installRealReminder(sendImpl?: () => Promise<never>): void {
    const stripe: StripeService = {
      ...fakeStripe(),
      listPaymentMethods: async (customerId: string) =>
        customerId === CUSTOMER ? cards : [],
      getDefaultPaymentMethodId: async () => cards[0]?.id ?? null,
    };
    fakeApp.invoiceReviewerService = {
      runReviewCycle: async () => ({
        finalized: 0,
        failed: 0,
        skipped: 0,
        reconciledPaid: 0,
        reconciledFailed: 0,
        stillPending: 0,
        errors: [],
      }),
    };
    fakeApp.cardExpiryReminderService = createCardExpiryReminderService({
      billing: BILLING,
      stripe,
      store: createDrizzleCardExpiryReminderStore({ db: testDb.db }),
      email: {
        sendCardExpiryReminder:
          sendImpl ??
          (async (input) => {
            sends.push(input);
            return { sent: true, provider: 'log' };
          }),
      },
      builders: createBuilderService({
        db: testDb.db,
        audit: { log: async () => undefined } as unknown as AdminAuditStore,
      }),
      memberships: createDrizzleMembershipStore({ db: testDb.db }),
      audit: createBillingAuditService({ db: testDb.db, newId: nextId }),
    });
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    const builderId = randomUUID();
    await testDb.db.insert(builders).values({
      id: builderId,
      tenantKey: TENANT,
      businessName: 'Card Reminder Builders Ltd',
      displayName: 'Card Reminder',
      plan: 'commission',
    });
    await testDb.db.insert(tenants).values({
      tenantKey: TENANT,
      businessName: 'Card Reminder Builders Ltd',
      displayName: 'Card Reminder',
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: CUSTOMER,
    });
    const adminId = randomUUID();
    const memberId = randomUUID();
    await testDb.db.insert(users).values([
      { id: adminId, email: 'admin@card-reminder.example', name: 'Admin', status: 'active' },
      { id: memberId, email: 'member@card-reminder.example', name: 'Member', status: 'active' },
    ]);
    await testDb.db.insert(builderMemberships).values([
      { id: randomUUID(), userId: adminId, builderId, role: 'builder_admin' },
      { id: randomUUID(), userId: memberId, builderId, role: 'builder_member' },
    ]);
  }, 60_000);
  afterAll(async () => {
    fakeApp.cardExpiryReminderService = NOOP_REMINDERS;
    await testDb.close();
  });

  it('sends exactly one reminder per card across runs; a replaced card gets its own', async () => {
    cards = [expiringCard('pm_first', '4242')];
    sends = [];
    installRealReminder();

    const first = makeContext();
    await expect(invoiceReviewerTimerHandler(first.context)).resolves.toBeUndefined();
    expect(sends.map((s) => s.to)).toEqual(['admin@card-reminder.example']);
    expect(sends[0]).toMatchObject({ last4: '4242', businessName: 'Card Reminder Builders Ltd' });
    const summary = first.lines().find((l) => l.includes('card reminders complete'))!;
    expect(summary).toContain('reminded=1');
    expect(summary).toContain('emailsSent=1');
    // Aggregates only — no tenant key, email or card id in the log.
    expect(summary).not.toMatch(/@|card-reminder-builder|pm_first/);

    const claims = await testDb.db
      .select()
      .from(cardExpiryReminders)
      .where(eq(cardExpiryReminders.paymentMethodId, 'pm_first'));
    expect(claims).toHaveLength(1);
    const audit = await testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.eventType, 'card.expiry_reminder_sent'));
    expect(audit.map((r) => r.entityId)).toEqual(['pm_first']);

    // Second run (or a host retry): nothing new.
    const second = makeContext();
    await invoiceReviewerTimerHandler(second.context);
    expect(sends).toHaveLength(1);
    expect(second.lines().join('\n')).toContain('alreadyReminded=1');

    // Two overlapping runs (scale-out) on the same card: still one email.
    await Promise.all([
      invoiceReviewerTimerHandler(makeContext().context),
      invoiceReviewerTimerHandler(makeContext().context),
    ]);
    expect(sends).toHaveLength(1);

    // The builder replaces the card: the new card gets its own reminder.
    cards = [expiringCard('pm_second', '5555')];
    await invoiceReviewerTimerHandler(makeContext().context);
    expect(sends.map((s) => s.last4)).toEqual(['4242', '5555']);
  });

  it('a send failure releases the claim (retried next run) and is logged', async () => {
    cards = [expiringCard('pm_flaky', '0005')];
    sends = [];
    installRealReminder(async () => {
      throw new Error('email provider unavailable');
    });
    const failed = makeContext();
    await expect(invoiceReviewerTimerHandler(failed.context)).resolves.toBeUndefined();
    const all = failed.lines().join('\n');
    expect(all).toContain('failed=1');
    expect(all).toContain('card reminder failed: email provider unavailable');
    const claims = await testDb.db
      .select()
      .from(cardExpiryReminders)
      .where(eq(cardExpiryReminders.paymentMethodId, 'pm_flaky'));
    expect(claims).toHaveLength(0);

    installRealReminder();
    await invoiceReviewerTimerHandler(makeContext().context);
    expect(sends.map((s) => s.last4)).toEqual(['0005']);
  });

  it('logs CARD REMINDER FAILED and rethrows when the reminder cycle dies', async () => {
    fakeApp.cardExpiryReminderService = {
      runReminderCycle: vi
        .fn()
        .mockRejectedValue(new Error('relation "card_expiry_reminders" does not exist')),
    };
    const { context, lines } = makeContext();
    await expect(invoiceReviewerTimerHandler(context)).rejects.toThrow('card_expiry_reminders');
    expect(lines().join('\n')).toContain('CARD REMINDER FAILED');
    // The review cycle still ran and logged first.
    expect(lines()[0]).toContain('cycle complete');
  });
});

describe('invoice-reviewer timer — stale pending refund sweep (#892)', () => {
  const okReview = () => ({
    runReviewCycle: vi.fn().mockResolvedValue({
      finalized: 0,
      failed: 0,
      skipped: 0,
      reconciledPaid: 0,
      reconciledFailed: 0,
      stillPending: 0,
      retried: 0,
      overdueReminded: 0,
      errors: [],
    }),
  });

  it('runs the sweep with the run time and logs aggregates only', async () => {
    fakeApp.invoiceReviewerService = okReview();
    const sweep = vi.fn().mockResolvedValue({
      checked: 3,
      adopted: 1,
      failed: 1,
      unresolved: 1,
      errors: [{ refundId: 'r-1', message: 'lookup failed' }],
    });
    fakeApp.commissionService = { sweepStalePendingRefunds: sweep };
    const { context, lines } = makeContext();
    await invoiceReviewerTimerHandler(context);
    expect(sweep).toHaveBeenCalledWith(expect.any(Date));
    const log = lines().join('\n');
    expect(log).toContain(
      'pending refund sweep complete (checked=3 adopted=1 failed=1 unresolved=1 errors=1)',
    );
    expect(log).toContain('refund sweep row failed: lookup failed');
    fakeApp.commissionService = NOOP_SWEEP;
  });

  it('logs REFUND SWEEP FAILED and rethrows; the other passes still run', async () => {
    const review = okReview();
    fakeApp.invoiceReviewerService = review;
    const reminders = vi.fn().mockResolvedValue({
      checked: 0,
      reminded: 0,
      emailsSent: 0,
      alreadyReminded: 0,
      skipped: 0,
      errors: [],
    });
    fakeApp.cardExpiryReminderService = { runReminderCycle: reminders };
    fakeApp.commissionService = {
      sweepStalePendingRefunds: vi.fn().mockRejectedValue(new Error('relation "billing_refunds" does not exist')),
    };
    const { context, lines } = makeContext();
    await expect(invoiceReviewerTimerHandler(context)).rejects.toThrow('billing_refunds');
    expect(lines().join('\n')).toContain('REFUND SWEEP FAILED');
    expect(review.runReviewCycle).toHaveBeenCalledTimes(1);
    expect(reminders).toHaveBeenCalledTimes(1);
    fakeApp.cardExpiryReminderService = NOOP_REMINDERS;
    fakeApp.commissionService = NOOP_SWEEP;
  });
});
