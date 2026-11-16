/**
 * Admin invoice corrections (#715): refunds (full / partial, idempotent),
 * void, contract correction and manual-payment reversal.
 *
 * Runs the real commission service against PGlite with the real migration
 * SQL. The payment provider is a fake that behaves like Stripe on
 * idempotency: the same idempotency key returns the same refund and never
 * creates a second one. No network, no real charges.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { CommissionInvoice } from '@feasly/contracts';
import {
  createCommissionService,
  type CommissionInvoiceRecord,
  type CommissionService,
} from '../src/services/billing/commission.service';
import { createBillingAuditService } from '../src/services/billing/billing-audit.service';
import { createBillingService } from '../src/services/billing/billing.service';
import {
  createAttributionService,
  type AttributionService,
} from '../src/services/billing/attribution.service';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import type {
  OpsAlertFailureContext,
  OpsAlertType,
} from '../src/services/ops-alerts.service';
import {
  attributionEvents,
  builders,
  estimates,
  leads,
  tenants,
} from '../src/db/schema';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
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

const FIXED_NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY_MS = 86_400_000;
const ADMIN = 'ops-admin@example.com';

/** $1,875,000 contract at 1% = $18,750 commission (the AC1 example). */
const CONTRACT_CENTS = 187_500_000;
const COMMISSION_CENTS = 1_875_000;

interface ProviderRefund {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly amountCents: number | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  status: string;
}

/**
 * Stripe-like fake: refunds are keyed by idempotency key, exactly like
 * Stripe — a repeated key returns the first refund. `failNextRefund`
 * injects one provider error. #892: `loseNextResponse` creates the refund
 * but throws (the response was lost on the wire); `forgetIdempotencyKeys`
 * simulates Stripe dropping keys after ~24h — the refunds themselves stay
 * and `findRefundByMetadata` lists them like `refunds.list`.
 */
function fakeStripe() {
  let pi = 0;
  const refunds = new Map<string, ProviderRefund>();
  /** Every refund ever created — survives idempotency-key expiry. */
  const allRefunds: ProviderRefund[] = [];
  const refundCalls: { idempotencyKey: string; amountCents?: number; metadata?: Record<string, string> }[] = [];
  const lookupCalls: { paymentIntentId: string; feaslyRefundId: string }[] = [];
  let failNextRefund: unknown = null;
  let loseNextResponse = false;
  let failNextLookup: unknown = null;
  const service: StripeService = {
    isConfigured: true,
    testMode: true,
    createCustomer: async () => ({ id: 'cus_test_123' }),
    createSetupIntent: async () => ({ id: 'seti_1', clientSecret: 'seti_secret' }),
    getPaymentIntentConfirmation: async (id: string) => ({ id, status: 'requires_action', clientSecret: `${id}_secret_test` }),
    listPaymentMethods: async () => [],
    updateCustomer: async () => undefined,
    getDefaultPaymentMethodId: async () => null,
    setDefaultPaymentMethod: async () => undefined,
    detachPaymentMethod: async (id: string) => ({ id }),
    clearCustomerId: async () => null,
    createOffSessionPaymentIntent: async () => {
      pi += 1;
      return { id: `pi_adj_${pi}_${randomUUID().slice(0, 8)}`, status: 'processing' };
    },
    createSubscription: async () => ({ id: 'sub_1', status: 'active' }),
    cancelSubscription: async (id) => ({ id }),
    retrievePaymentIntent: async (id) => ({ id, status: 'processing' }),
    refundPaymentIntent: async (paymentIntentId, idempotencyKey, amountCents, metadata) => {
      refundCalls.push({ idempotencyKey, amountCents, ...(metadata ? { metadata: { ...metadata } } : {}) });
      if (failNextRefund !== null) {
        const error = failNextRefund;
        failNextRefund = null;
        throw error;
      }
      const existing = refunds.get(idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status };
      const refund: ProviderRefund = {
        id: `re_${allRefunds.length + 1}_${randomUUID().slice(0, 6)}`,
        paymentIntentId,
        amountCents,
        metadata: { ...(metadata ?? {}) },
        status: 'succeeded',
      };
      refunds.set(idempotencyKey, refund);
      allRefunds.push(refund);
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error('socket hang up');
      }
      return { id: refund.id, status: 'succeeded' };
    },
    findRefundByMetadata: async (paymentIntentId, feaslyRefundId) => {
      lookupCalls.push({ paymentIntentId, feaslyRefundId });
      if (failNextLookup !== null) {
        const error = failNextLookup;
        failNextLookup = null;
        throw error;
      }
      const match = allRefunds.find(
        (r) => r.paymentIntentId === paymentIntentId && r.metadata['feasly_refund_id'] === feaslyRefundId,
      );
      return match ? { id: match.id, status: match.status } : null;
    },
    verifyWebhook: () => {
      throw new Error('not used');
    },
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
    getCustomerId: async () => 'cus_test_123',
  };
  return Object.assign(service, {
    refunds,
    allRefunds,
    refundCalls,
    lookupCalls,
    failNext(error: unknown) {
      failNextRefund = error;
    },
    loseNextResponse() {
      loseNextResponse = true;
    },
    failNextLookup(error: unknown) {
      failNextLookup = error;
    },
    forgetIdempotencyKeys() {
      refunds.clear();
    },
  });
}

function fakeEmail() {
  const sent: { op: string; input: unknown }[] = [];
  const ok = async () => ({ sent: true as const, provider: 'log' as const });
  const record = (op: string) => async (input: unknown) => {
    sent.push({ op, input });
    return ok();
  };
  const service = {
    sendOpsAlert: record('sendOpsAlert'),
    sendCommissionInvoiceReady: record('sendCommissionInvoiceReady'),
    sendCommissionPaymentReceived: record('sendCommissionPaymentReceived'),
    sendCommissionPaymentFailed: record('sendCommissionPaymentFailed'),
  };
  return Object.assign(service as unknown as EmailService, { sent });
}

function fakeAdminAudit() {
  const entries: { action: string; actorEmail: string | null; detail?: string }[] = [];
  return {
    entries,
    log: async (entry: { action: string; actorEmail: string | null; detail?: string }) => {
      entries.push(entry);
    },
  };
}

function fakeOpsAlerts() {
  const calls: { op: 'failure' | 'recovered'; type: string; context?: unknown }[] = [];
  return {
    calls,
    notifyFailure: async (type: OpsAlertType, context: OpsAlertFailureContext) => {
      calls.push({ op: 'failure', type, context });
    },
    notifyRecovered: async (type: OpsAlertType) => {
      calls.push({ op: 'recovered', type });
    },
  };
}

interface Harness {
  commission: CommissionService;
  attribution: AttributionService;
  stripe: ReturnType<typeof fakeStripe>;
  email: ReturnType<typeof fakeEmail>;
  adminAudit: ReturnType<typeof fakeAdminAudit>;
  opsAlerts: ReturnType<typeof fakeOpsAlerts>;
  /** Mutable service clock (defaults to FIXED_NOW). */
  clock: { now: Date };
}

describe('admin invoice corrections (#715)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  function harness(): Harness {
    const stripe = fakeStripe();
    const email = fakeEmail();
    const adminAudit = fakeAdminAudit();
    const opsAlerts = fakeOpsAlerts();
    const clock = { now: new Date(FIXED_NOW) };
    const attribution = createAttributionService({
      db: testDb.db,
      billing: BILLING,
      now: () => new Date(FIXED_NOW),
    });
    const audit = createBillingAuditService({ db: testDb.db });
    const commission = createCommissionService({
      db: testDb.db,
      billing: BILLING,
      attribution,
      audit,
      stripe,
      email,
      opsInbox: 'ops@example.com',
      now: () => new Date(clock.now),
      adminAudit,
      opsAlerts,
    });
    return { commission, attribution, stripe, email, adminAudit, opsAlerts, clock };
  }

  async function seedBuilder(): Promise<string> {
    const tenantKey = `adj-${randomUUID().slice(0, 8)}`;
    await testDb.db.insert(tenants).values({
      tenantKey,
      businessName: `${tenantKey} Ltd.`,
      displayName: tenantKey,
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: 'cus_test_123',
    });
    await testDb.db.insert(builders).values({
      id: randomUUID(),
      tenantKey,
      businessName: `${tenantKey} Ltd.`,
      displayName: tenantKey,
      commissionRatePercent: 1,
      email: `billing@${tenantKey}.example`,
    });
    return tenantKey;
  }

  /** A fresh draft invoice for a $1,875,000 contract. */
  async function draftInvoice(h: Harness): Promise<CommissionInvoiceRecord> {
    const tenantKey = await seedBuilder();
    const estimateId = randomUUID();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: '1-adjust-st-calgary',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    const leadId = randomUUID();
    await testDb.db.insert(leads).values({
      id: leadId,
      estimateId,
      addressKey: '1-adjust-st-calgary',
      email: 'homeowner@example.com',
      name: 'Test Homeowner',
      timeline: '6-12 months',
      consentTs: new Date('2026-10-01T09:00:00.000Z'),
    });
    const intro = await h.attribution.recordIntroduction({
      leadId,
      tenantKey,
      introducedAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    const reported = await h.attribution.reportContract({
      attributionId: intro.id,
      contractValueCents: CONTRACT_CENTS,
      contractSignedAt: new Date('2026-11-10T10:00:00.000Z'),
      reportedAt: new Date('2026-11-12T10:00:00.000Z'),
    });
    return h.commission.createDraftInvoice(reported.id);
  }

  async function inReviewInvoice(h: Harness): Promise<CommissionInvoiceRecord> {
    return h.commission.submitForReview((await draftInvoice(h)).id);
  }

  async function finalizedInvoice(h: Harness): Promise<CommissionInvoiceRecord> {
    return h.commission.finalizeInvoice((await inReviewInvoice(h)).id);
  }

  async function cardPaidInvoice(h: Harness): Promise<CommissionInvoiceRecord> {
    const finalized = await finalizedInvoice(h);
    return h.commission.markPaidByPaymentIntent(
      finalized.stripePaymentIntentId as string,
    );
  }

  async function failedInvoice(h: Harness): Promise<CommissionInvoiceRecord> {
    const finalized = await finalizedInvoice(h);
    return h.commission.markFailedByPaymentIntent(
      finalized.stripePaymentIntentId as string,
      'Your card was declined.',
    );
  }

  async function manuallyPaidInvoice(h: Harness): Promise<CommissionInvoiceRecord> {
    const inReview = await inReviewInvoice(h);
    return h.commission.markPaidManually(inReview.id, {
      paymentMethod: 'cheque',
      reference: 'CHQ-2041',
      adminEmail: ADMIN,
    });
  }

  async function events(invoiceId: string) {
    return testDb.rows<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from billing_events where entity_id = '${invoiceId}' order by created_at, id`,
    );
  }

  async function expectHttpError(
    promise: Promise<unknown>,
    status: number,
    message?: RegExp,
  ): Promise<HttpError> {
    const error = await promise.then(
      () => {
        throw new Error(`expected HTTP ${status}, call succeeded`);
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    if (message) expect((error as HttpError).message).toMatch(message);
    return error as HttpError;
  }

  const key = () => `refund-${randomUUID()}`;

  describe('refunds', () => {
    it('AC1: $500 partial then the remainder — two provider refunds, totals reconcile, a third is 422', async () => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      expect(paid.totalCents).toBe(COMMISSION_CENTS);

      const first = await h.commission.refundInvoice(paid.id, {
        amountCents: 50_000,
        reason: 'billing_error',
        note: 'Rate agreed at 0.97%',
        idempotencyKey: key(),
        adminEmail: ADMIN,
      });
      expect(first.replayed).toBe(false);
      expect(first.refund).toMatchObject({
        amountCents: 50_000,
        method: 'stripe',
        status: 'succeeded',
        reason: 'billing_error',
        actorEmail: ADMIN,
      });
      expect(first.refund.stripeRefundId).toMatch(/^re_/);
      expect(first.invoice).toMatchObject({
        status: 'paid',
        refundedCents: 50_000,
        refundState: 'partially_refunded',
      });

      // Amount omitted = refund whatever is left.
      const second = await h.commission.refundInvoice(paid.id, {
        reason: 'deal_fell_through',
        idempotencyKey: key(),
        adminEmail: ADMIN,
      });
      expect(second.refund.amountCents).toBe(COMMISSION_CENTS - 50_000);
      expect(second.invoice).toMatchObject({
        status: 'paid',
        refundedCents: COMMISSION_CENTS,
        refundState: 'refunded',
      });

      // The provider shows exactly two refunds, partial amounts each.
      expect([...h.stripe.refunds.values()].map((r) => r.amountCents)).toEqual([
        50_000,
        COMMISSION_CENTS - 50_000,
      ]);
      // Refund rows on the invoice detail add up to the refunded total.
      const detail = await h.commission.getById(paid.id);
      expect(detail.refunds?.map((r) => r.amountCents)).toEqual([
        50_000,
        COMMISSION_CENTS - 50_000,
      ]);
      expect(
        detail.refunds?.reduce((sum, r) => sum + r.amountCents, 0),
      ).toBe(detail.refundedCents);

      const third = await expectHttpError(
        h.commission.refundInvoice(paid.id, {
          amountCents: 1,
          reason: 'other',
          idempotencyKey: key(),
          adminEmail: ADMIN,
        }),
        422,
        /fully refunded/,
      );
      expect(third.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(h.stripe.refunds.size).toBe(2);

      // Audit: billing_events + admin_audit_log with the admin identity.
      const refundedEvents = (await events(paid.id)).filter(
        (e) => e.event_type === 'invoice.refunded',
      );
      expect(refundedEvents).toHaveLength(2);
      expect(refundedEvents[1].payload).toMatchObject({
        refundedCents: COMMISSION_CENTS,
        netCents: 0,
        refundState: 'refunded',
        adminEmail: ADMIN,
        // The provider's own refund status is recorded for #719 reconciliation.
        providerStatus: 'succeeded',
      });
      expect(
        h.adminAudit.entries.filter((e) => e.action === 'billing.invoice_refunded'),
      ).toHaveLength(2);
      expect(h.adminAudit.entries.every((e) => e.actorEmail === ADMIN)).toBe(true);

      // Conformance: the record's refund fields satisfy the public DTO.
      const dto: Pick<CommissionInvoice, 'refundedCents' | 'refundState'> = detail;
      expect(dto.refundState).toBe('refunded');
    });

    it('rejects a refund larger than what is left with 422 and creates nothing', async () => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      await expectHttpError(
        h.commission.refundInvoice(paid.id, {
          amountCents: COMMISSION_CENTS + 1,
          reason: 'other',
          idempotencyKey: key(),
          adminEmail: ADMIN,
        }),
        422,
        /exceeds/,
      );
      expect(h.stripe.refundCalls).toHaveLength(0);
      expect((await h.commission.getById(paid.id)).refundedCents).toBe(0);
    });

    it('AC2: a retried request with the same key returns the first refund — one provider refund', async () => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      const idempotencyKey = key();
      const input = {
        amountCents: 50_000,
        reason: 'goodwill' as const,
        idempotencyKey,
        adminEmail: ADMIN,
      };
      const first = await h.commission.refundInvoice(paid.id, input);
      const retry = await h.commission.refundInvoice(paid.id, input);
      expect(retry.replayed).toBe(true);
      expect(retry.refund.id).toBe(first.refund.id);
      expect(retry.invoice.refundedCents).toBe(50_000);
      expect(h.stripe.refunds.size).toBe(1);
    });

    it('AC2: a double-click (two concurrent requests, same key) creates exactly one refund', async () => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      const input = {
        amountCents: 75_000,
        reason: 'duplicate' as const,
        idempotencyKey: key(),
        adminEmail: ADMIN,
      };
      const [a, b] = await Promise.all([
        h.commission.refundInvoice(paid.id, input),
        h.commission.refundInvoice(paid.id, input),
      ]);
      expect(a.refund.id).toBe(b.refund.id);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(h.stripe.refunds.size).toBe(1);
      const detail = await h.commission.getById(paid.id);
      expect(detail.refundedCents).toBe(75_000);
      expect(detail.refunds).toHaveLength(1);
    });

    it('two concurrent full refunds with different keys: one wins, the loser leaves no refund row', async () => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      const base = { reason: 'duplicate' as const, adminEmail: ADMIN };
      const results = await Promise.allSettled([
        h.commission.refundInvoice(paid.id, { ...base, idempotencyKey: key() }),
        h.commission.refundInvoice(paid.id, { ...base, idempotencyKey: key() }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
      const detail = await h.commission.getById(paid.id);
      // Claim + reservation are one transaction: the loser rolled back whole.
      expect(detail.refunds).toHaveLength(1);
      expect(detail.refundedCents).toBe(COMMISSION_CENTS);
      expect(h.stripe.refunds.size).toBe(1);
    });

    it('a transient provider error keeps the refund pending; the retry resumes it — still one refund', async () => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      const input = {
        amountCents: 10_000,
        reason: 'billing_error' as const,
        idempotencyKey: key(),
        adminEmail: ADMIN,
      };
      h.stripe.failNext(new Error('socket hang up'));
      await expect(h.commission.refundInvoice(paid.id, input)).rejects.toThrow(
        'socket hang up',
      );
      const pending = await h.commission.getById(paid.id);
      expect(pending.refunds?.[0]?.status).toBe('pending');
      // The claim is held so nothing else can over-refund meanwhile.
      expect(pending.refundedCents).toBe(10_000);
      // Not final yet → no audit trail yet.
      expect((await events(paid.id)).filter((e) => e.event_type === 'invoice.refunded')).toHaveLength(0);
      expect(h.adminAudit.entries.filter((e) => e.action === 'billing.invoice_refunded')).toHaveLength(0);

      const resumed = await h.commission.refundInvoice(paid.id, input);
      expect(resumed.replayed).toBe(true);
      expect(resumed.refund.status).toBe('succeeded');
      expect(resumed.invoice.refundedCents).toBe(10_000);
      expect(h.stripe.refunds.size).toBe(1);
      // Both provider calls used the same provider idempotency key.
      expect(new Set(h.stripe.refundCalls.map((c) => c.idempotencyKey)).size).toBe(1);
      // The retry that finished the refund wrote the audit trail — once.
      const refunded = (await events(paid.id)).filter((e) => e.event_type === 'invoice.refunded');
      expect(refunded).toHaveLength(1);
      expect(refunded[0]?.payload).toMatchObject({
        refundId: resumed.refund.id,
        amountCents: 10_000,
        method: 'stripe',
        reason: 'billing_error',
        resumed: true,
        adminEmail: ADMIN,
      });
      expect(refunded[0]?.payload.stripeRefundId).toEqual(expect.any(String));
      const adminRows = h.adminAudit.entries.filter((e) => e.action === 'billing.invoice_refunded');
      expect(adminRows).toHaveLength(1);
      expect(adminRows[0]).toMatchObject({ actorEmail: ADMIN });
      expect(adminRows[0]?.detail).toContain(`refund=${resumed.refund.id}`);

      // A further replay of the now-final refund writes nothing more.
      await h.commission.refundInvoice(paid.id, input);
      expect((await events(paid.id)).filter((e) => e.event_type === 'invoice.refunded')).toHaveLength(1);
      expect(h.adminAudit.entries.filter((e) => e.action === 'billing.invoice_refunded')).toHaveLength(1);
    });

    it.each([409, 429])('a provider %i (idempotency in flight / rate limit) is transient: row stays pending, retry finishes it once', async (statusCode) => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      const input = {
        amountCents: 10_000,
        reason: 'billing_error' as const,
        idempotencyKey: key(),
        adminEmail: ADMIN,
      };
      h.stripe.failNext({ statusCode });
      await expect(h.commission.refundInvoice(paid.id, input)).rejects.toBeDefined();
      const pending = await h.commission.getById(paid.id);
      expect(pending.refunds?.[0]?.status).toBe('pending');
      expect(pending.refundedCents).toBe(10_000);
      expect((await events(paid.id)).map((e) => e.event_type)).not.toContain('invoice.refund_failed');

      const resumed = await h.commission.refundInvoice(paid.id, input);
      expect(resumed.refund.status).toBe('succeeded');
      expect(resumed.invoice.refundedCents).toBe(10_000);
      expect(h.stripe.refunds.size).toBe(1);
      expect((await events(paid.id)).filter((e) => e.event_type === 'invoice.refunded')).toHaveLength(1);
      expect(h.adminAudit.entries.filter((e) => e.action === 'billing.invoice_refunded')).toHaveLength(1);
    });

    it('a definitive provider rejection fails the refund and releases the amount', async () => {
      const h = harness();
      const paid = await cardPaidInvoice(h);
      const input = {
        amountCents: 10_000,
        reason: 'billing_error' as const,
        idempotencyKey: key(),
        adminEmail: ADMIN,
      };
      h.stripe.failNext(
        new HttpError(422, ErrorCodes.VALIDATION_FAILED, 'charge already refunded'),
      );
      await expectHttpError(h.commission.refundInvoice(paid.id, input), 422);
      const after = await h.commission.getById(paid.id);
      expect(after.refundedCents).toBe(0);
      expect(after.refunds?.[0]?.status).toBe('failed');
      expect((await events(paid.id)).map((e) => e.event_type)).toContain(
        'invoice.refund_failed',
      );
      // Reusing the failed key is refused; a new key works.
      await expectHttpError(h.commission.refundInvoice(paid.id, input), 409, /new key/);
      const ok = await h.commission.refundInvoice(paid.id, { ...input, idempotencyKey: key() });
      expect(ok.invoice.refundedCents).toBe(10_000);
    });

    describe('resume after the provider idempotency key expired (#892)', () => {
      const refundInput = () => ({
        amountCents: 10_000,
        reason: 'billing_error' as const,
        idempotencyKey: key(),
        adminEmail: ADMIN,
      });

      it('tags every card refund with the refund row id as metadata', async () => {
        const h = harness();
        const paid = await cardPaidInvoice(h);
        const result = await h.commission.refundInvoice(paid.id, refundInput());
        expect(h.stripe.refundCalls).toHaveLength(1);
        expect(h.stripe.refundCalls[0]?.metadata).toEqual({
          feasly_refund_id: result.refund.id,
          feasly_invoice_id: paid.id,
        });
        // A first attempt has nothing to look up.
        expect(h.stripe.lookupCalls).toHaveLength(0);
      });

      it('a lost response retried after the key expired adopts the existing refund — no second refund', async () => {
        const h = harness();
        const paid = await cardPaidInvoice(h);
        const input = refundInput();
        h.stripe.loseNextResponse();
        await expect(h.commission.refundInvoice(paid.id, input)).rejects.toThrow('socket hang up');
        const pending = await h.commission.getById(paid.id);
        const refundId = pending.refunds?.[0]?.id as string;
        expect(pending.refunds?.[0]?.status).toBe('pending');
        // The provider DID create the refund; then it forgot the key (>24h).
        expect(h.stripe.allRefunds).toHaveLength(1);
        h.stripe.forgetIdempotencyKeys();

        const resumed = await h.commission.refundInvoice(paid.id, input);
        expect(resumed.replayed).toBe(true);
        expect(resumed.refund.status).toBe('succeeded');
        expect(resumed.refund.stripeRefundId).toBe(h.stripe.allRefunds[0]?.id);
        expect(resumed.invoice.refundedCents).toBe(10_000);
        // Still exactly one provider refund, and no second create call.
        expect(h.stripe.allRefunds).toHaveLength(1);
        expect(h.stripe.refundCalls).toHaveLength(1);
        expect(h.stripe.lookupCalls).toEqual([
          { paymentIntentId: paid.stripePaymentIntentId, feaslyRefundId: refundId },
        ]);
        const refunded = (await events(paid.id)).filter((e) => e.event_type === 'invoice.refunded');
        expect(refunded).toHaveLength(1);
        expect(refunded[0]?.payload).toMatchObject({ refundId, resumed: true, adminEmail: ADMIN });
      });

      it('a resume that finds no provider refund creates it (with the same metadata) — once', async () => {
        const h = harness();
        const paid = await cardPaidInvoice(h);
        const input = refundInput();
        h.stripe.failNext(new Error('ECONNRESET'));
        await expect(h.commission.refundInvoice(paid.id, input)).rejects.toThrow('ECONNRESET');
        expect(h.stripe.allRefunds).toHaveLength(0);

        const resumed = await h.commission.refundInvoice(paid.id, input);
        expect(resumed.refund.status).toBe('succeeded');
        expect(h.stripe.lookupCalls).toHaveLength(1);
        expect(h.stripe.allRefunds).toHaveLength(1);
        expect(h.stripe.allRefunds[0]?.metadata['feasly_refund_id']).toBe(resumed.refund.id);
      });

      it('a provider lookup error leaves the refund pending with its claim held', async () => {
        const h = harness();
        const paid = await cardPaidInvoice(h);
        const input = refundInput();
        h.stripe.failNext(new Error('ECONNRESET'));
        await expect(h.commission.refundInvoice(paid.id, input)).rejects.toThrow();
        h.stripe.failNextLookup(new HttpError(404, ErrorCodes.NOT_FOUND, 'lookup failed'));
        await expect(h.commission.refundInvoice(paid.id, input)).rejects.toThrow('lookup failed');
        const after = await h.commission.getById(paid.id);
        expect(after.refunds?.[0]?.status).toBe('pending');
        expect(after.refundedCents).toBe(10_000);
        expect(h.stripe.allRefunds).toHaveLength(0);
      });

      it('an adopted provider refund that failed fails the row and releases the claim (409)', async () => {
        const h = harness();
        const paid = await cardPaidInvoice(h);
        const input = refundInput();
        h.stripe.loseNextResponse();
        await expect(h.commission.refundInvoice(paid.id, input)).rejects.toThrow();
        h.stripe.forgetIdempotencyKeys();
        (h.stripe.allRefunds[0] as ProviderRefund).status = 'failed';

        await expectHttpError(h.commission.refundInvoice(paid.id, input), 409, /new key/);
        const after = await h.commission.getById(paid.id);
        expect(after.refunds?.[0]?.status).toBe('failed');
        expect(after.refundedCents).toBe(0);
        expect(h.stripe.refundCalls).toHaveLength(1);
        expect((await events(paid.id)).map((e) => e.event_type)).toContain('invoice.refund_failed');
      });
    });

    describe('stale pending refund sweep (#892)', () => {
      it('adopts old rows found on the provider, alerts on unresolved ones, skips fresh ones', async () => {
        const h = harness();
        // An epoch well before every other test's refunds (FIXED_NOW), so
        // only this test's rows can be stale at `sweepAt`.
        const t0 = new Date('2026-06-01T08:00:00.000Z');
        const sweepAt = new Date(t0.getTime() + 25 * 3_600_000);

        // A: provider created it, response lost — stale.
        const paidA = await cardPaidInvoice(h);
        h.clock.now = t0;
        h.stripe.loseNextResponse();
        await expect(h.commission.refundInvoice(paidA.id, { amountCents: 10_000, reason: 'billing_error', idempotencyKey: key(), adminEmail: ADMIN })).rejects.toThrow();
        // B: the call never reached the provider — stale, nothing to adopt.
        h.clock.now = new Date(FIXED_NOW);
        const paidB = await cardPaidInvoice(h);
        h.clock.now = t0;
        const inputB = { amountCents: 20_000, reason: 'goodwill' as const, idempotencyKey: key(), adminEmail: ADMIN };
        h.stripe.failNext(new Error('ECONNRESET'));
        await expect(h.commission.refundInvoice(paidB.id, inputB)).rejects.toThrow();
        // C: response lost 23h after t0 — only 2h old at sweepAt, so fresh.
        h.clock.now = new Date(FIXED_NOW);
        const paidC = await cardPaidInvoice(h);
        h.clock.now = new Date(t0.getTime() + 23 * 3_600_000);
        h.stripe.loseNextResponse();
        await expect(h.commission.refundInvoice(paidC.id, { amountCents: 5_000, reason: 'billing_error', idempotencyKey: key(), adminEmail: ADMIN })).rejects.toThrow();
        h.stripe.forgetIdempotencyKeys();
        h.clock.now = sweepAt;
        const createsBefore = h.stripe.refundCalls.length;

        const result = await h.commission.sweepStalePendingRefunds(sweepAt);
        expect(result).toEqual({ checked: 2, adopted: 1, failed: 0, unresolved: 1, errors: [] });
        // The sweep never creates a refund.
        expect(h.stripe.refundCalls).toHaveLength(createsBefore);

        const a = await h.commission.getById(paidA.id);
        expect(a.refunds?.[0]?.status).toBe('succeeded');
        expect(a.refunds?.[0]?.stripeRefundId).toBe(h.stripe.allRefunds[0]?.id);
        expect(a.refundedCents).toBe(10_000);
        const refundedA = (await events(paidA.id)).filter((e) => e.event_type === 'invoice.refunded');
        expect(refundedA).toHaveLength(1);
        expect(refundedA[0]?.payload).toMatchObject({ resumed: true, adminEmail: ADMIN });

        const b = await h.commission.getById(paidB.id);
        expect(b.refunds?.[0]?.status).toBe('pending');
        expect(b.refundedCents).toBe(20_000);
        const c = await h.commission.getById(paidC.id);
        expect(c.refunds?.[0]?.status).toBe('pending');

        expect(h.opsAlerts.calls).toEqual([
          {
            op: 'failure',
            type: 'billing_refund_pending_stale',
            context: { consecutiveFailures: 1, firstFailureAt: t0 },
          },
        ]);

        // A second sweep is a no-op for A (already final).
        const again = await h.commission.sweepStalePendingRefunds(sweepAt);
        expect(again).toMatchObject({ checked: 1, adopted: 0, unresolved: 1 });
        expect((await events(paidA.id)).filter((e) => e.event_type === 'invoice.refunded')).toHaveLength(1);

        // The admin retries B: lookup finds nothing, so it is created once.
        const retried = await h.commission.refundInvoice(paidB.id, inputB);
        expect(retried.refund.status).toBe('succeeded');
        const cleared = await h.commission.sweepStalePendingRefunds(sweepAt);
        expect(cleared).toEqual({ checked: 0, adopted: 0, failed: 0, unresolved: 0, errors: [] });
        expect(h.opsAlerts.calls.at(-1)).toEqual({ op: 'recovered', type: 'billing_refund_pending_stale' });

        // C becomes stale later and is adopted then.
        const later = new Date(t0.getTime() + 48 * 3_600_000);
        const swept = await h.commission.sweepStalePendingRefunds(later);
        expect(swept).toMatchObject({ checked: 1, adopted: 1, unresolved: 0 });
        expect((await h.commission.getById(paidC.id)).refunds?.[0]?.status).toBe('succeeded');
      });

      it('a provider refund found as canceled fails the row and releases the claim', async () => {
        const h = harness();
        const t0 = new Date('2026-05-01T08:00:00.000Z');
        const paid = await cardPaidInvoice(h);
        h.clock.now = t0;
        h.stripe.loseNextResponse();
        await expect(h.commission.refundInvoice(paid.id, { amountCents: 10_000, reason: 'billing_error', idempotencyKey: key(), adminEmail: ADMIN })).rejects.toThrow();
        (h.stripe.allRefunds[0] as ProviderRefund).status = 'canceled';
        // Before the first sweep test's epoch, so only this row is stale.
        const result = await h.commission.sweepStalePendingRefunds(new Date(t0.getTime() + 25 * 3_600_000));
        expect(result).toEqual({ checked: 1, adopted: 0, failed: 1, unresolved: 0, errors: [] });
        const after = await h.commission.getById(paid.id);
        expect(after.refunds?.[0]?.status).toBe('failed');
        expect(after.refundedCents).toBe(0);
      });
    });

    it('a manually paid invoice records an off-Stripe refund and requires a reference', async () => {
      const h = harness();
      const paid = await manuallyPaidInvoice(h);
      await expectHttpError(
        h.commission.refundInvoice(paid.id, {
          amountCents: 20_000,
          reason: 'billing_error',
          idempotencyKey: key(),
          adminEmail: ADMIN,
        }),
        422,
        /reference/,
      );
      const result = await h.commission.refundInvoice(paid.id, {
        amountCents: 20_000,
        reason: 'billing_error',
        reference: 'ETR-77812',
        idempotencyKey: key(),
        adminEmail: ADMIN,
      });
      expect(result.refund).toMatchObject({
        method: 'manual',
        status: 'succeeded',
        reference: 'ETR-77812',
        stripeRefundId: null,
      });
      expect(result.invoice.refundState).toBe('partially_refunded');
      expect(h.stripe.refundCalls).toHaveLength(0);
    });

    it('only a paid invoice can be refunded (409)', async () => {
      const h = harness();
      const inReview = await inReviewInvoice(h);
      await expectHttpError(
        h.commission.refundInvoice(inReview.id, {
          reason: 'other',
          idempotencyKey: key(),
          adminEmail: ADMIN,
        }),
        409,
        /void it instead/,
      );
    });

    it('reusing a key on a different invoice is a 409', async () => {
      const h = harness();
      const a = await cardPaidInvoice(h);
      const b = await cardPaidInvoice(h);
      const idempotencyKey = key();
      await h.commission.refundInvoice(a.id, {
        amountCents: 100,
        reason: 'other',
        idempotencyKey,
        adminEmail: ADMIN,
      });
      await expectHttpError(
        h.commission.refundInvoice(b.id, {
          amountCents: 100,
          reason: 'other',
          idempotencyKey,
          adminEmail: ADMIN,
        }),
        409,
        /different invoice/,
      );
    });
  });

  describe('void', () => {
    it('AC3: voids from draft, in_review and failed', async () => {
      const h = harness();
      for (const make of [draftInvoice, inReviewInvoice, failedInvoice]) {
        const invoice = await make(h);
        const result = await h.commission.voidInvoice(invoice.id, {
          reason: 'created_in_error',
          note: 'Wrong lead',
          adminEmail: ADMIN,
        });
        expect(result.previousStatus).toBe(invoice.status);
        expect(result.invoice.status).toBe('void');
        expect(result.invoice.reviewDueAt).toBeNull();
        const voided = (await events(invoice.id)).find((e) => e.event_type === 'invoice.voided');
        expect(voided?.payload).toMatchObject({
          from: invoice.status,
          reason: 'created_in_error',
          note: 'Wrong lead',
          adminEmail: ADMIN,
        });
      }
      expect(
        h.adminAudit.entries.filter((e) => e.action === 'billing.invoice_voided'),
      ).toHaveLength(3);
    });

    it('AC3: 409 from finalized and paid (and disputed / void)', async () => {
      const h = harness();
      const input = { reason: 'duplicate' as const, adminEmail: ADMIN };
      await expectHttpError(
        h.commission.voidInvoice((await finalizedInvoice(h)).id, input),
        409,
        /charge is in flight/,
      );
      await expectHttpError(
        h.commission.voidInvoice((await cardPaidInvoice(h)).id, input),
        409,
        /refund it instead/,
      );
      const disputed = await h.commission.disputeInvoice(
        (await inReviewInvoice(h)).id,
        'Not our lead',
      );
      await expectHttpError(h.commission.voidInvoice(disputed.id, input), 409, /dispute console/);
      const draft = await draftInvoice(h);
      await h.commission.voidInvoice(draft.id, input);
      await expectHttpError(h.commission.voidInvoice(draft.id, input), 409, /already void/);
    });

    it('AC3: the reviewer timer and retries never charge a void invoice', async () => {
      const h = harness();
      const inReview = await inReviewInvoice(h);
      await h.commission.voidInvoice(inReview.id, { reason: 'deal_fell_through', adminEmail: ADMIN });
      const due = await h.commission.findDueReviews(
        new Date(FIXED_NOW.getTime() + 30 * DAY_MS),
      );
      expect(due.map((i) => i.id)).not.toContain(inReview.id);
      await expectHttpError(h.commission.finalizeInvoice(inReview.id), 409);

      const failed = await failedInvoice(h);
      await h.commission.voidInvoice(failed.id, { reason: 'other', adminEmail: ADMIN });
      await expectHttpError(h.commission.retryCharge(failed.id), 409);
    });
  });

  describe('contract correction', () => {
    it('AC4: in_review — commission recalculated, review window restarted, builder emailed, originals audited', async () => {
      const h = harness();
      const inReview = await inReviewInvoice(h);
      const result = await h.commission.correctContract(inReview.id, {
        contractValueCents: 150_000_000,
        contractSignedAt: new Date('2026-11-09T10:00:00.000Z'),
        note: 'Builder reported the gross price incl. land',
        adminEmail: ADMIN,
      });
      expect(result.previousContractValueCents).toBe(CONTRACT_CENTS);
      expect(result.invoice).toMatchObject({
        status: 'in_review',
        contractValueCents: 150_000_000,
        commissionCents: 1_500_000,
        totalCents: 1_500_000,
      });
      expect(result.invoice.reviewDueAt?.toISOString()).toBe(
        new Date(FIXED_NOW.getTime() + 7 * DAY_MS).toISOString(),
      );

      // The attribution's reported contract follows the invoice.
      const attribution = await testDb.db.query.attributionEvents.findFirst({
        where: eq(attributionEvents.id, inReview.attributionId),
      });
      expect(attribution?.contractValueCents).toBe(150_000_000);
      expect(attribution?.contractSignedAt?.toISOString()).toBe('2026-11-09T10:00:00.000Z');

      // Builder is emailed the corrected figures with the new window.
      const ready = h.email.sent.filter((s) => s.op === 'sendCommissionInvoiceReady');
      expect(ready.at(-1)?.input).toMatchObject({
        commissionCents: 1_500_000,
        contractValueCents: 150_000_000,
      });

      const corrected = (await events(inReview.id)).find(
        (e) => e.event_type === 'invoice.contract_corrected',
      );
      expect(corrected?.payload).toMatchObject({
        note: 'Builder reported the gross price incl. land',
        adminEmail: ADMIN,
        old: {
          contractValueCents: CONTRACT_CENTS,
          contractSignedAt: '2026-11-10T10:00:00.000Z',
          commissionCents: COMMISSION_CENTS,
        },
        new: { contractValueCents: 150_000_000, commissionCents: 1_500_000 },
      });
      expect(h.adminAudit.entries.map((e) => e.action)).toContain(
        'billing.invoice_contract_corrected',
      );
    });

    it('a draft is corrected without an email (not issued yet)', async () => {
      const h = harness();
      const draft = await draftInvoice(h);
      const result = await h.commission.correctContract(draft.id, {
        contractValueCents: 100_000_000,
        contractSignedAt: new Date('2026-11-09T10:00:00.000Z'),
        note: 'Typo',
        adminEmail: ADMIN,
      });
      expect(result.invoice).toMatchObject({ status: 'draft', commissionCents: 1_000_000 });
      expect(h.email.sent.filter((s) => s.op === 'sendCommissionInvoiceReady')).toHaveLength(0);
    });

    it('is refused once the invoice is charged (409) and needs a note (422)', async () => {
      const h = harness();
      const input = {
        contractValueCents: 100_000_000,
        contractSignedAt: new Date('2026-11-09T10:00:00.000Z'),
        note: 'Fix',
        adminEmail: ADMIN,
      };
      await expectHttpError(
        h.commission.correctContract((await finalizedInvoice(h)).id, input),
        409,
      );
      await expectHttpError(
        h.commission.correctContract((await cardPaidInvoice(h)).id, input),
        409,
      );
      await expectHttpError(
        h.commission.correctContract((await inReviewInvoice(h)).id, { ...input, note: '  ' }),
        422,
      );
    });
  });

  describe('manual payment reversal', () => {
    it('AC5: a manually paid invoice goes back to failed with a mandatory reason', async () => {
      const h = harness();
      const paid = await manuallyPaidInvoice(h);
      await expectHttpError(
        h.commission.reverseManualPayment(paid.id, { reason: ' ', adminEmail: ADMIN }),
        422,
      );
      const result = await h.commission.reverseManualPayment(paid.id, {
        reason: 'Cheque returned NSF',
        adminEmail: ADMIN,
      });
      expect(result).toMatchObject({
        reversedPaymentMethod: 'cheque',
        reversedReference: 'CHQ-2041',
      });
      expect(result.invoice).toMatchObject({
        status: 'failed',
        paidAt: null,
        manualPaymentMethod: null,
        paymentReference: null,
      });
      const reversed = (await events(paid.id)).find(
        (e) => e.event_type === 'invoice.payment_reversed',
      );
      expect(reversed?.payload).toMatchObject({
        reason: 'Cheque returned NSF',
        reversedPaymentMethod: 'cheque',
        reversedReference: 'CHQ-2041',
        adminEmail: ADMIN,
      });
      expect(h.adminAudit.entries.map((e) => e.action)).toContain(
        'billing.invoice_payment_reversed',
      );
      // The replacement payment can be recorded again.
      const repaid = await h.commission.markPaidManually(paid.id, {
        paymentMethod: 'e_transfer',
        reference: 'ETR-1',
        adminEmail: ADMIN,
      });
      expect(repaid.status).toBe('paid');
    });

    it('card-paid and refunded invoices cannot be reversed (409)', async () => {
      const h = harness();
      await expectHttpError(
        h.commission.reverseManualPayment((await cardPaidInvoice(h)).id, {
          reason: 'x',
          adminEmail: ADMIN,
        }),
        409,
        /refund it instead/,
      );
      const manual = await manuallyPaidInvoice(h);
      await h.commission.refundInvoice(manual.id, {
        amountCents: 100,
        reason: 'goodwill',
        reference: 'CHQ-R1',
        idempotencyKey: key(),
        adminEmail: ADMIN,
      });
      await expectHttpError(
        h.commission.reverseManualPayment(manual.id, { reason: 'x', adminEmail: ADMIN }),
        409,
        /refunds recorded/,
      );
    });
  });
});

describe('builder-scoped invoice reads hide the refunding admin (#715 AC7)', () => {
  it('builders see refunds without the staff email; admins see it', async () => {
    const record = {
      id: 'inv-1',
      tenantKey: 'elite-craft',
      refundedCents: 50_000,
      refundState: 'partially_refunded',
      refunds: [{ id: 'rf-1', amountCents: 50_000, actorEmail: ADMIN, note: 'internal: escalated by ops' }],
    } as unknown as CommissionInvoiceRecord;
    const billing = createBillingService({
      leadStore: {} as never,
      billingHook: {} as never,
      builders: { getByTenantKey: async () => null },
      commission: { getById: async () => record } as unknown as CommissionService,
    });
    const builderView = await billing.getInvoice('inv-1', 'elite-craft');
    expect(builderView.refunds?.[0]).toMatchObject({ amountCents: 50_000, actorEmail: null, note: null });
    expect(builderView.refundedCents).toBe(50_000);
    const adminView = await billing.getInvoice('inv-1', null);
    expect(adminView.refunds?.[0]?.actorEmail).toBe(ADMIN);
    expect(adminView.refunds?.[0]?.note).toBe('internal: escalated by ops');
  });
});
