/**
 * Dunning schedule tests (#718).
 *
 * Owner decision (2026-11-15): the retry schedule follows each invoice's
 * grace period; admin can edit it per invoice and pause / resume / cancel
 * retries; the builder portal can only pay now; failed payments email the
 * builder.
 *
 * Runs against PGlite with the real migration SQL. The clock is injected
 * (no sleeps). The fake payment provider honours idempotency keys like
 * Stripe does — the same key returns the same PaymentIntent — so "double
 * submission creates one charge" is asserted on distinct PaymentIntents.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createCommissionService,
  type CommissionService,
} from '../src/services/billing/commission.service';
import {
  createBillingAuditService,
  type BillingAuditService,
} from '../src/services/billing/billing-audit.service';
import { createInvoiceReviewerService } from '../src/services/billing/invoice-reviewer.service';
import {
  createAttributionService,
  type AttributionService,
} from '../src/services/billing/attribution.service';
import type {
  OffSessionChargeResult,
  StripeService,
} from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import type { BillingConfig } from '../src/config';
import { billingEvents, commissionInvoices, estimates, leads, tenants } from '../src/db/schema';
import { ErrorCodes } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const DAY_MS = 86_400_000;
const START = new Date('2026-11-01T15:00:00.000Z');

function billingConfig(over: Partial<BillingConfig> = {}): BillingConfig {
  return {
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
    maxChargeRetries: 3,
    dunningGraceDays: 7,
    ...over,
  };
}

interface Sent {
  readonly op: string;
  readonly input: Record<string, unknown>;
}

/** Records every email op without sending. */
function fakeEmail(): EmailService & { sent: Sent[] } {
  const sent: Sent[] = [];
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'sent') return sent;
      return async (input: Record<string, unknown>) => {
        sent.push({ op: String(prop), input });
        return { sent: true, provider: 'log' as const };
      };
    },
  };
  return new Proxy({}, handler) as EmailService & { sent: Sent[] };
}

/** Global so PaymentIntent ids stay unique across fixtures (UNIQUE column). */
let piCounter = 0;

interface ChargeCall {
  readonly idempotencyKey: string;
  readonly intent: OffSessionChargeResult;
}

/**
 * Fake provider: every charge declines unless `succeed` is set. Same
 * idempotency key → same PaymentIntent (Stripe semantics).
 */
function fakeStripe(): StripeService & {
  calls: ChargeCall[];
  succeed: boolean;
} {
  const byKey = new Map<string, OffSessionChargeResult>();
  const service = {
    calls: [] as ChargeCall[],
    succeed: false,
    isConfigured: true,
    testMode: true,
    updateCustomer: async () => undefined,
    getDefaultPaymentMethodId: async () => null,
    setDefaultPaymentMethod: async () => undefined,
    detachPaymentMethod: async (id: string) => ({ id }),
    clearCustomerId: async () => null,
    createCustomer: async () => ({ id: 'cus_test' }),
    createSetupIntent: async () => ({ id: 'seti_test', clientSecret: 's' }),
    listPaymentMethods: async () => [],
    async createOffSessionPaymentIntent(
      _input: unknown,
      idempotencyKey: string,
    ): Promise<OffSessionChargeResult> {
      let intent = byKey.get(idempotencyKey);
      if (intent === undefined) {
        piCounter += 1;
        intent = service.succeed
          ? { id: `pi_dunning_${piCounter}`, status: 'processing' }
          : {
              id: `pi_dunning_${piCounter}`,
              status: 'requires_payment_method',
              errorCode: 'card_declined',
              declineCode: 'insufficient_funds',
              failureMessage: 'Your card has insufficient funds.',
            };
        byKey.set(idempotencyKey, intent);
      }
      service.calls.push({ idempotencyKey, intent });
      return intent;
    },
    createSubscription: async () => ({ id: 'sub_test', status: 'active' }),
    cancelSubscription: async (id: string) => ({ id }),
    retrievePaymentIntent: async (id: string) => ({ id, status: 'processing' }),
    getPaymentIntentConfirmation: async (id: string) => ({
      id,
      status: 'requires_action',
      clientSecret: `${id}_secret`,
    }),
    refundPaymentIntent: async () => ({ id: 're_test', status: 'succeeded' }),
    verifyWebhook: () => {
      throw new Error('not used');
    },
    getCustomerId: async () => 'cus_test_123',
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
  };
  return service as unknown as StripeService & { calls: ChargeCall[]; succeed: boolean };
}

interface Fx {
  commission: CommissionService;
  audit: BillingAuditService;
  billing: BillingConfig;
  attribution: AttributionService;
  stripe: ReturnType<typeof fakeStripe>;
  email: ReturnType<typeof fakeEmail>;
  clock: { now: Date };
  advanceDays(days: number): void;
}

function newServices(testDb: TestDb, billing = billingConfig()): Fx {
  const clock = { now: new Date(START) };
  const stripe = fakeStripe();
  const email = fakeEmail();
  const attribution = createAttributionService({
    db: testDb.db,
    billing,
    now: () => new Date(clock.now),
  });
  const audit = createBillingAuditService({ db: testDb.db });
  const commission = createCommissionService({
    db: testDb.db,
    billing,
    attribution,
    audit,
    stripe,
    email,
    opsInbox: 'ops@example.com',
    now: () => new Date(clock.now),
    logWarning: () => undefined,
  });
  return {
    commission,
    audit,
    billing,
    attribution,
    stripe,
    email,
    clock,
    advanceDays(days: number) {
      clock.now = new Date(clock.now.getTime() + days * DAY_MS);
    },
  };
}

async function seedInReview(testDb: TestDb, fx: Fx, tenantKey: string) {
  await testDb.db.insert(tenants).values({
    tenantKey,
    businessName: 'Dunning Builder Inc',
    displayName: 'Dunning Builder',
    accentColor: '#B08D57',
    allowedOrigins: ['https://dunning.example'],
    stripeCustomerId: 'cus_test_123',
    fallbackEmail: `${tenantKey}@example.com`,
  });
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    projectType: 'new_build',
    addressKey: '1-dunning-st-calgary',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.2.0',
  });
  const leadId = randomUUID();
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: '1-dunning-st-calgary',
    email: 'homeowner@example.com',
    name: 'Dunning Homeowner',
    timeline: '6-12 months',
    consentTs: new Date('2026-03-01T09:00:00.000Z'),
  });
  const intro = await fx.attribution.recordIntroduction({
    leadId,
    tenantKey,
    introducedAt: new Date('2026-09-01T10:00:00.000Z'),
  });
  const reported = await fx.attribution.reportContract({
    attributionId: intro.id,
    contractValueCents: 50_000_000,
    contractSignedAt: new Date('2026-10-25T10:00:00.000Z'),
    reportedAt: new Date('2026-10-26T10:00:00.000Z'),
  });
  const draft = await fx.commission.createDraftInvoice(reported.id);
  return fx.commission.submitForReview(draft.id);
}

/** In-review → finalize (declined) → failed, at the review deadline. */
async function seedFailed(testDb: TestDb, fx: Fx, tenantKey: string) {
  const inReview = await seedInReview(testDb, fx, tenantKey);
  fx.advanceDays(7);
  const failed = await fx.commission.finalizeInvoice(inReview.id);
  expect(failed.status).toBe('failed');
  return failed;
}

function ops(fx: Fx, op: string): Sent[] {
  return fx.email.sent.filter((s) => s.op === op);
}

describe('dunning schedule (#718)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  async function events(invoiceId: string) {
    return testDb.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.entityId, invoiceId));
  }

  it('a failed charge schedules the next retry one grace period later and emails the date', async () => {
    const fx = newServices(testDb, billingConfig({ dunningGraceDays: 3 }));
    const failed = await seedFailed(testDb, fx, 'dun-schedule');
    const failedAt = fx.clock.now;

    expect(failed.retryGraceDays).toBe(3);
    expect(failed.maxChargeRetries).toBe(3);
    expect(failed.dunningState).toBe('active');
    expect(failed.nextRetryAt?.toISOString()).toBe(
      new Date(failedAt.getTime() + 3 * DAY_MS).toISOString(),
    );
    const failedRow = (await events(failed.id)).find((e) => e.eventType === 'invoice.charge_failed');
    expect(failedRow?.payload).toMatchObject({
      retryCount: 0,
      nextRetryAt: failed.nextRetryAt?.toISOString(),
    });
    const declined = ops(fx, 'sendCommissionPaymentFailed');
    expect(declined).toHaveLength(1);
    expect(declined[0]!.input).toMatchObject({ finalNotice: false, updateWithinDays: 3 });
    expect((declined[0]!.input['nextRetryAt'] as Date).toISOString()).toBe(
      failed.nextRetryAt?.toISOString(),
    );
  });

  it('retries on the configured days with a distinct idempotency key each, then flags collections once', async () => {
    const fx = newServices(testDb);
    const failed = await seedFailed(testDb, fx, 'dun-full-run');

    // Not due yet.
    fx.advanceDays(6);
    expect((await fx.commission.findDueRetries(fx.clock.now)).map((i) => i.id)).not.toContain(failed.id);
    await expect(
      fx.commission.retryCharge(failed.id, { trigger: 'schedule' }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fx.advanceDays(attempt === 1 ? 1 : 7);
      const due = await fx.commission.findDueRetries(fx.clock.now);
      expect(due.map((i) => i.id)).toContain(failed.id);
      const result = await fx.commission.retryCharge(failed.id, { trigger: 'schedule' });
      expect(result.status).toBe('failed');
      expect(result.retryCount).toBe(attempt);
    }

    const keys = fx.stripe.calls.map((c) => c.idempotencyKey);
    expect(keys).toEqual([
      `feasly:commission_invoices:${failed.id}:charge`,
      `feasly:commission_invoices:${failed.id}:retry:1`,
      `feasly:commission_invoices:${failed.id}:retry:2`,
      `feasly:commission_invoices:${failed.id}:retry:3`,
    ]);
    const retried = (await events(failed.id)).filter((e) => e.eventType === 'invoice.charge_retried');
    expect(retried).toHaveLength(3);
    expect(retried.every((e) => (e.payload as { trigger?: string }).trigger === 'schedule')).toBe(true);

    // Final attempt → collections: no further retry, one collections alert,
    // final-notice email, exactly one email per step.
    const final = await fx.commission.getById(failed.id);
    expect(final.collectionsAt).not.toBeNull();
    expect(final.nextRetryAt).toBeNull();
    expect((await events(failed.id)).filter((e) => e.eventType === 'invoice.collections_flagged')).toHaveLength(1);
    const alerts = ops(fx, 'sendOpsAlert').map((s) => s.input['title']);
    expect(alerts.filter((t) => t === 'Billing invoice flagged for collections')).toHaveLength(1);
    const declined = ops(fx, 'sendCommissionPaymentFailed');
    expect(declined).toHaveLength(4);
    expect(declined.map((s) => s.input['finalNotice'])).toEqual([false, false, false, true]);

    fx.advanceDays(30);
    expect((await fx.commission.findDueRetries(fx.clock.now)).map((i) => i.id)).not.toContain(failed.id);
  });

  it('admin pause stops the schedule; resume reschedules from the last failure; cancel clears it', async () => {
    const fx = newServices(testDb);
    const failed = await seedFailed(testDb, fx, 'dun-pause');
    const failedAt = fx.clock.now;

    const paused = await fx.commission.updateDunning(failed.id, { action: 'pause' }, 'admin@example.com');
    expect(paused.dunningState).toBe('paused');
    expect(paused.nextRetryAt).toBeNull();
    fx.advanceDays(10);
    expect((await fx.commission.findDueRetries(fx.clock.now)).map((i) => i.id)).not.toContain(failed.id);
    await expect(
      fx.commission.retryCharge(failed.id, { trigger: 'schedule' }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    const resumed = await fx.commission.updateDunning(failed.id, { action: 'resume' }, 'admin@example.com');
    expect(resumed.dunningState).toBe('active');
    expect(resumed.nextRetryAt?.toISOString()).toBe(new Date(failedAt.getTime() + 7 * DAY_MS).toISOString());
    expect((await fx.commission.findDueRetries(fx.clock.now)).map((i) => i.id)).toContain(failed.id);

    const regraced = await fx.commission.updateDunning(
      failed.id,
      { action: 'set_grace_days', graceDays: 14 },
      'admin@example.com',
    );
    expect(regraced.retryGraceDays).toBe(14);
    expect(regraced.nextRetryAt?.toISOString()).toBe(new Date(failedAt.getTime() + 14 * DAY_MS).toISOString());
    expect((await fx.commission.findDueRetries(fx.clock.now)).map((i) => i.id)).not.toContain(failed.id);

    const cancelled = await fx.commission.updateDunning(failed.id, { action: 'cancel' }, 'admin@example.com');
    expect(cancelled.dunningState).toBe('cancelled');
    expect(cancelled.nextRetryAt).toBeNull();

    const audit = (await events(failed.id)).filter((e) => e.eventType === 'invoice.dunning_updated');
    expect(audit.map((e) => (e.payload as { action: string }).action)).toEqual([
      'pause',
      'resume',
      'set_grace_days',
      'cancel',
    ]);
    expect((audit[0]!.payload as { adminEmail: string }).adminEmail).toBe('admin@example.com');
  });

  it('rejects an out-of-range grace period and schedule edits on settled or disputed invoices', async () => {
    const fx = newServices(testDb);
    const failed = await seedFailed(testDb, fx, 'dun-reject');
    await expect(
      fx.commission.updateDunning(failed.id, { action: 'set_grace_days', graceDays: 0 }, null),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    await expect(
      fx.commission.updateDunning(failed.id, { action: 'set_grace_days', graceDays: 91 }, null),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });

    const paid = await fx.commission.markPaidManually(failed.id, {
      paymentMethod: 'cheque',
      adminEmail: null,
    });
    expect(paid.nextRetryAt).toBeNull();
    await expect(
      fx.commission.updateDunning(failed.id, { action: 'pause' }, null),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    const fx2 = newServices(testDb);
    const inReview = await seedInReview(testDb, fx2, 'dun-reject-disputed');
    const disputed = await fx2.commission.disputeInvoice(inReview.id, 'wrong amount');
    await expect(
      fx2.commission.updateDunning(disputed.id, { action: 'resume' }, null),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
    // Disputed invoices never enter dunning: no charge, no declined email.
    expect(fx2.stripe.calls).toHaveLength(0);
    expect(ops(fx2, 'sendCommissionPaymentFailed')).toHaveLength(0);
  });

  it('Pay now settles a failed invoice even while retries are paused; double submission creates one charge', async () => {
    const fx = newServices(testDb);
    const failed = await seedFailed(testDb, fx, 'dun-pay-now');
    await fx.commission.updateDunning(failed.id, { action: 'pause' }, null);
    fx.stripe.succeed = true; // the builder saved a working card

    const [a, b] = await Promise.all([
      fx.commission.payNow(failed.id),
      fx.commission.payNow(failed.id),
    ]);
    expect(a.status).toBe('finalized');
    expect(b.status).toBe('finalized');
    expect(a.stripePaymentIntentId).toBe(b.stripePaymentIntentId);

    // A third click after the first landed: unchanged, no new provider call.
    const callsBefore = fx.stripe.calls.length;
    const again = await fx.commission.payNow(failed.id);
    expect(again.status).toBe('finalized');
    expect(fx.stripe.calls).toHaveLength(callsBefore);

    const distinctIntents = new Set(fx.stripe.calls.map((c) => c.intent.id));
    // First (declined) charge + exactly one Pay now charge.
    expect(distinctIntents.size).toBe(2);
    const retried = (await events(failed.id)).filter((e) => e.eventType === 'invoice.charge_retried');
    expect(retried).toHaveLength(1);
    expect((retried[0]!.payload as { trigger: string }).trigger).toBe('builder');

    const paid = await fx.commission.markPaidByPaymentIntent(a.stripePaymentIntentId!);
    expect(paid.status).toBe('paid');
    expect(paid.nextRetryAt).toBeNull();
  });

  it('Pay now works after collections (past the retry cap) and keeps the single collections flag', async () => {
    const fx = newServices(testDb, billingConfig({ maxChargeRetries: 1 }));
    const failed = await seedFailed(testDb, fx, 'dun-pay-collections');
    fx.advanceDays(7);
    const exhausted = await fx.commission.retryCharge(failed.id, { trigger: 'schedule' });
    expect(exhausted.collectionsAt).not.toBeNull();
    // Admin retry is capped; the builder's Pay now is not.
    await expect(fx.commission.retryCharge(failed.id)).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_FAILED,
    });
    const stillDeclined = await fx.commission.payNow(failed.id);
    expect(stillDeclined.status).toBe('failed');
    expect(stillDeclined.retryCount).toBe(2);
    expect(stillDeclined.collectionsAt?.toISOString()).toBe(exhausted.collectionsAt?.toISOString());
    expect((await events(failed.id)).filter((e) => e.eventType === 'invoice.collections_flagged')).toHaveLength(1);
    // The Pay now failure still emails the builder, without a retry date.
    const last = ops(fx, 'sendCommissionPaymentFailed').at(-1)!;
    expect(last.input).toMatchObject({ finalNotice: false, nextRetryAt: null });
  });

  it('Pay now attempts share the retry budget: exhausting it via Pay now flags collections and sends the final notice', async () => {
    const fx = newServices(testDb, billingConfig({ maxChargeRetries: 2 }));
    const failed = await seedFailed(testDb, fx, 'dun-pay-budget');

    const first = await fx.commission.payNow(failed.id);
    expect(first.status).toBe('failed');
    expect(first.retryCount).toBe(1);
    expect(first.collectionsAt).toBeNull();
    // One retry left → the automatic schedule is still armed.
    expect(first.nextRetryAt).not.toBeNull();

    const second = await fx.commission.payNow(failed.id);
    expect(second.status).toBe('failed');
    expect(second.retryCount).toBe(2);
    expect(second.collectionsAt).not.toBeNull();
    expect(second.nextRetryAt).toBeNull();

    // No automatic attempt ran, yet the budget is spent: the admin retry is
    // capped and the final notice went out once.
    const retried = (await events(failed.id)).filter((e) => e.eventType === 'invoice.charge_retried');
    expect(retried.map((e) => (e.payload as { trigger: string }).trigger)).toEqual(['builder', 'builder']);
    await expect(fx.commission.retryCharge(failed.id)).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_FAILED,
    });
    const declined = ops(fx, 'sendCommissionPaymentFailed');
    expect(declined.map((s) => s.input['finalNotice'])).toEqual([false, false, true]);
    expect((await events(failed.id)).filter((e) => e.eventType === 'invoice.collections_flagged')).toHaveLength(1);
  });

  it('Pay now refuses invoices that are not failed card invoices', async () => {
    const fx = newServices(testDb);
    const inReview = await seedInReview(testDb, fx, 'dun-pay-refuse');
    await expect(fx.commission.payNow(inReview.id)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
    fx.advanceDays(7);
    const failed = await fx.commission.finalizeInvoice(inReview.id);
    await fx.commission.setInvoicePaymentMethod('dun-pay-refuse', failed.id, 'cheque');
    await expect(fx.commission.payNow(failed.id)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });

  it('a manual-method invoice past its due date gets exactly one overdue reminder and shows as overdue', async () => {
    const fx = newServices(testDb, billingConfig({ dunningGraceDays: 5 }));
    const tenantKey = 'dun-manual';
    const inReview = await seedInReview(testDb, fx, tenantKey);
    const manual = await fx.commission.setInvoicePaymentMethod(tenantKey, inReview.id, 'e_transfer');
    const reviewDueAt = manual.reviewDueAt!;
    expect(manual.dueAt?.toISOString()).toBe(new Date(reviewDueAt.getTime() + 5 * DAY_MS).toISOString());
    expect(manual.overdueDays).toBe(0);

    // Review window closed, still inside the grace period.
    fx.advanceDays(9);
    expect((await fx.commission.findOverdueManualInvoices(fx.clock.now)).map((i) => i.id)).not.toContain(manual.id);

    fx.advanceDays(5); // 2 days past due
    const overdue = await fx.commission.findOverdueManualInvoices(fx.clock.now);
    expect(overdue.map((i) => i.id)).toContain(manual.id);
    const reminded = await fx.commission.sendOverdueReminder(manual.id);
    expect(reminded?.overdueDays).toBe(2);
    expect(await fx.commission.sendOverdueReminder(manual.id)).toBeNull();
    expect((await fx.commission.findOverdueManualInvoices(fx.clock.now)).map((i) => i.id)).not.toContain(manual.id);

    const reminders = ops(fx, 'sendCommissionInvoiceOverdue');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.input['to']).toBe(`${tenantKey}@example.com`);
    expect((reminders[0]!.input['dueAt'] as Date).toISOString()).toBe(manual.dueAt?.toISOString());
    expect((await events(manual.id)).filter((e) => e.eventType === 'invoice.overdue_reminder')).toHaveLength(1);
    // Builder + admin see it as overdue on the record.
    expect((await fx.commission.getById(manual.id)).overdueDays).toBe(2);
    // Never charged.
    expect(fx.stripe.calls).toHaveLength(0);
  });

  it('a paused manual invoice gets no overdue reminder', async () => {
    const fx = newServices(testDb);
    const tenantKey = 'dun-manual-paused';
    const inReview = await seedInReview(testDb, fx, tenantKey);
    await fx.commission.setInvoicePaymentMethod(tenantKey, inReview.id, 'cheque');
    await fx.commission.updateDunning(inReview.id, { action: 'pause' }, null);
    fx.advanceDays(30);
    expect((await fx.commission.findOverdueManualInvoices(fx.clock.now)).map((i) => i.id)).not.toContain(inReview.id);
    expect(await fx.commission.sendOverdueReminder(inReview.id)).toBeNull();
    expect(ops(fx, 'sendCommissionInvoiceOverdue')).toHaveLength(0);
  });

  it('legacy failed invoices (no retry date) are never auto-retried until an admin resumes them', async () => {
    const fx = newServices(testDb);
    const failed = await seedFailed(testDb, fx, 'dun-legacy');
    await testDb.db
      .update(commissionInvoices)
      .set({ nextRetryAt: null, lastChargeFailedAt: null })
      .where(eq(commissionInvoices.id, failed.id));
    fx.advanceDays(60);
    expect((await fx.commission.findDueRetries(fx.clock.now)).map((i) => i.id)).not.toContain(failed.id);
    const resumed = await fx.commission.updateDunning(failed.id, { action: 'resume' }, null);
    expect(resumed.nextRetryAt?.toISOString()).toBe(new Date(fx.clock.now.getTime() + 7 * DAY_MS).toISOString());
  });
});

describe('invoice reviewer runs the dunning schedule (#718)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('retries due card invoices and reminds overdue manual ones, once each, on an injected clock', async () => {
    const fx = newServices(testDb);
    const reviewer = createInvoiceReviewerService({
      billing: fx.billing,
      commission: fx.commission,
      audit: fx.audit,
      stripe: fx.stripe,
    });
    const due = await seedInReview(testDb, fx, 'rev-due');
    const paused = await seedInReview(testDb, fx, 'rev-paused');
    const manual = await seedInReview(testDb, fx, 'rev-manual');
    await fx.commission.setInvoicePaymentMethod('rev-manual', manual.id, 'bank_draft');

    // Review deadline: both card invoices are charged and declined.
    fx.advanceDays(7);
    const first = await reviewer.runReviewCycle(fx.clock.now);
    expect(first).toMatchObject({ finalized: 2, retried: 0, overdueReminded: 0, failed: 0 });
    await fx.commission.updateDunning(paused.id, { action: 'pause' }, null);

    // One grace period later: the active one is retried, the manual one is
    // overdue (review end + 7 days), the paused one is left alone.
    fx.advanceDays(7);
    const second = await reviewer.runReviewCycle(fx.clock.now);
    expect(second).toMatchObject({ finalized: 0, retried: 1, overdueReminded: 1, failed: 0 });
    expect((await fx.commission.getById(due.id)).retryCount).toBe(1);
    expect((await fx.commission.getById(paused.id)).retryCount).toBe(0);

    // Same day again: nothing new — no double charge, no second reminder.
    const third = await reviewer.runReviewCycle(fx.clock.now);
    expect(third).toMatchObject({ retried: 0, overdueReminded: 0, failed: 0 });
    expect(ops(fx, 'sendCommissionInvoiceOverdue')).toHaveLength(1);
    const retryKeys = fx.stripe.calls
      .map((c) => c.idempotencyKey)
      .filter((k) => k.includes(':retry:'));
    expect(retryKeys).toEqual([`feasly:commission_invoices:${due.id}:retry:1`]);

    const cycle = await testDb.rows<{ payload: Record<string, unknown> }>(
      `select payload from billing_events where event_type = 'reviewer.cycle_completed' order by created_at desc limit 1`,
    );
    expect(cycle[0]!.payload).toMatchObject({ retried: 0, overdueReminded: 0 });
  });
});
