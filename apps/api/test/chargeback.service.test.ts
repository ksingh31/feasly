/**
 * Bank chargebacks + Stripe-dashboard refunds (#719).
 *
 * Drives the production billing webhook handler with Stripe-shaped
 * `charge.dispute.*` / `charge.refunded` events (normalized by the real
 * `normalizeStripeEvent`) against a PGlite database:
 * - created → one chargeback row, invoice flagged, one ops alert naming the
 *   evidence deadline; redelivery is a no-op.
 * - updated / funds_withdrawn / funds_reinstated → audit rows, deduped.
 * - closed won / lost → invoice chargeback state + audit rows; redelivery
 *   is a no-op; an out-of-order close still records the chargeback.
 * - charge.refunded → cumulative refunded amount + timeline row; stale or
 *   repeated amounts are no-ops.
 * - none of these types is recorded as `webhook.unhandled`.
 * - the disputes console lists chargebacks distinctly and refuses to
 *   accept/reject them; retryCharge refuses while a chargeback is open.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { createBillingWebhookService, type BillingWebhookService } from '../src/services/billing/billing-webhook.service';
import { createBillingAuditService, type BillingAuditService } from '../src/services/billing/billing-audit.service';
import { createCommissionService, type CommissionService } from '../src/services/billing/commission.service';
import { createAttributionService, type AttributionService } from '../src/services/billing/attribution.service';
import { createFlatPlanService } from '../src/services/billing/flat-plan.service';
import { createChargebackService, type ChargebackService } from '../src/services/billing/chargeback.service';
import { createDisputeService, type DisputeService } from '../src/services/billing/dispute.service';
import { normalizeStripeEvent } from '../src/services/billing/payment-provider';
import type { StripeService } from '../src/services/billing/stripe.service';
import type { EmailService } from '../src/services/email/email.service';
import type { OpsAlertsService } from '../src/services/ops-alerts.service';
import { billingDisputes, billingEvents, builders, commissionInvoices, estimates, leads, stripeEvents, tenants } from '../src/db/schema';
import { createBuilderService } from '../src/services/builder.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import { createTestDb, type TestDb } from './pglite-db';

const WEBHOOK_SECRET = 'whsec_chargeback_test';
const NOW = new Date('2026-11-16T18:00:00.000Z');
/** Evidence deadline: 2026-12-07T18:00:00Z (21 days after NOW). */
const DUE_BY = Math.floor(NOW.getTime() / 1000) + 21 * 86_400;

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

let idCounter = 7000;
const nextId = (): string =>
  `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
let piCounter = 0;
let evtCounter = 0;
const nextEventId = (): string => `evt_cb_${++evtCounter}`;

function fakeStripe(): StripeService {
  return {
    isConfigured: true,
    testMode: true,
    createCustomer: async () => ({ id: 'cus_cb' }),
    createSetupIntent: async () => ({ id: 'seti_cb', clientSecret: 'secret' }),
    listPaymentMethods: async () => [],
    createOffSessionPaymentIntent: async () => ({ id: `pi_cb_${++piCounter}`, status: 'processing' }),
    createSubscription: async () => ({ id: 'sub_cb', status: 'active' }),
    cancelSubscription: async (id: string) => ({ id }),
    refundPaymentIntent: async () => ({ id: 're_cb', status: 'succeeded' }),
    retrievePaymentIntent: async (id: string) => ({ id, status: 'processing' }),
    verifyWebhook: (rawBody: Buffer, signature: string | undefined) => {
      const expected = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
      if (signature !== `v1=${expected}`) {
        throw Object.assign(new Error('Invalid stripe signature'), { code: 'INVALID_SIGNATURE' });
      }
      return normalizeStripeEvent(JSON.parse(rawBody.toString('utf8')));
    },
    getCustomerId: async () => 'cus_cb',
    saveCustomerId: async () => {},
    getTenantKeyByCustomerId: async () => null,
  } as unknown as StripeService;
}

const alerts: { title: string; summary: string }[] = [];
/** Builder "payment failed" emails (#873 re-uses it with reason). */
const failedEmails: { to: string; reason?: string }[] = [];
function fakeEmail(): EmailService {
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'sendOpsAlert'
          ? async (input: { title: string; summary: string }) => {
              alerts.push({ title: input.title, summary: input.summary });
              return { sent: true, provider: 'log' as const };
            }
          : prop === 'sendCommissionPaymentFailed'
            ? async (input: { to: string; reason?: string }) => {
                failedEmails.push({ to: input.to, ...(input.reason ? { reason: input.reason } : {}) });
                return { sent: true, provider: 'log' as const };
              }
            : async () => ({ sent: true, provider: 'log' as const }),
    },
  ) as EmailService;
}

function sign(payload: unknown): [Buffer, string] {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return [body, `v1=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`];
}

function disputeEvent(
  type: string,
  piId: string,
  over: Record<string, unknown> = {},
  eventId = nextEventId(),
): unknown {
  return {
    id: eventId,
    type,
    data: {
      object: {
        id: `dp_${piId}`,
        object: 'dispute',
        amount: 505_000,
        currency: 'cad',
        charge: `ch_${piId}`,
        payment_intent: piId,
        reason: 'fraudulent',
        status: 'needs_response',
        evidence_details: { due_by: DUE_BY },
        livemode: false,
        ...over,
      },
    },
  };
}

function refundEvent(piId: string, amountRefunded: number, eventId = nextEventId()): unknown {
  return {
    id: eventId,
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${piId}`,
        object: 'charge',
        amount: 505_000,
        amount_refunded: amountRefunded,
        payment_intent: piId,
        currency: 'cad',
      },
    },
  };
}

describe('Stripe chargebacks + dashboard refunds (#719)', () => {
  let testDb: TestDb;
  let audit: BillingAuditService;
  let attribution: AttributionService;
  let commission: CommissionService;
  let chargebacks: ChargebackService;
  let webhook: BillingWebhookService;
  let disputes: DisputeService;
  let tenantSeq = 0;

  beforeAll(async () => {
    testDb = await createTestDb();
    const stripe = fakeStripe();
    const email = fakeEmail();
    const now = () => NOW;
    audit = createBillingAuditService({ db: testDb.db, newId: nextId });
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
    chargebacks = createChargebackService({
      db: testDb.db,
      audit,
      commission,
      email,
      opsInbox: 'ops@example.com',
      now,
      newId: nextId,
      logWarning: () => undefined,
    });
    webhook = createBillingWebhookService({
      db: testDb.db,
      stripe,
      audit,
      commission,
      flatPlan: createFlatPlanService({ billing: BILLING, audit, stripe, email, opsInbox: 'ops@example.com', now }),
      chargebacks,
      email,
      opsInbox: 'ops@example.com',
      now,
      logWarning: () => undefined,
    });
    disputes = createDisputeService({
      db: testDb.db,
      audit,
      commission,
      stripe,
      opsAlerts: { notifyFailure: async () => undefined } as unknown as OpsAlertsService,
      now,
      newId: nextId,
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.close();
  });

  beforeEach(() => {
    alerts.length = 0;
    failedEmails.length = 0;
  });

  /** A paid commission invoice, settled through the real webhook path. */
  async function paidInvoice() {
    const tenantKey = `cb-builder-${++tenantSeq}`;
    await testDb.db.insert(tenants).values({
      tenantKey,
      businessName: `${tenantKey} Builder`,
      displayName: tenantKey,
      accentColor: '#B08D57',
      allowedOrigins: ['https://example.com'],
      stripeCustomerId: 'cus_cb',
      fallbackEmail: `billing@${tenantKey}.example.com`,
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
      name: 'Chargeback Homeowner',
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
      contractValueCents: 50_500_000,
      contractSignedAt: new Date('2026-06-01T10:00:00.000Z'),
      reportedAt: new Date('2026-06-05T10:00:00.000Z'),
    });
    const draft = await commission.createDraftInvoice(reported.id);
    const finalized = await commission.finalizeInvoice((await commission.submitForReview(draft.id)).id);
    const piId = finalized.stripePaymentIntentId!;
    await commission.markPaidByPaymentIntent(piId);
    alerts.length = 0;
    return { tenantKey, invoiceId: finalized.id, piId };
  }

  async function deliver(payload: unknown) {
    return webhook.handleWebhook(...sign(payload));
  }

  async function auditsFor(entityId: string) {
    const rows = await testDb.db.select().from(billingEvents).where(eq(billingEvents.entityId, entityId));
    return rows.map((r) => r.eventType);
  }

  async function chargebackRows(invoiceId: string) {
    return testDb.db.select().from(billingDisputes).where(eq(billingDisputes.invoiceId, invoiceId));
  }

  it('normalizes dispute and refund fields', () => {
    const dispute = normalizeStripeEvent(disputeEvent('charge.dispute.created', 'pi_n') as never);
    expect(dispute.paymentIntentId).toBe('pi_n');
    expect(dispute.dispute).toEqual({
      id: 'dp_pi_n',
      amountCents: 505_000,
      currency: 'cad',
      reason: 'fraudulent',
      status: 'needs_response',
      evidenceDueAt: new Date(DUE_BY * 1000),
      livemode: false,
    });
    const refund = normalizeStripeEvent(refundEvent('pi_n', 1_234) as never);
    expect(refund.paymentIntentId).toBe('pi_n');
    expect(refund.amountRefundedCents).toBe(1_234);
    expect(refund.dispute).toBeUndefined();
  });

  it('AC1: charge.dispute.created → one chargeback, invoice flagged, one ops alert with the deadline', async () => {
    const { invoiceId, piId } = await paidInvoice();
    const created = disputeEvent('charge.dispute.created', piId);
    await deliver(created);

    const rows = await chargebackRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'chargeback',
      status: 'open',
      stripeDisputeId: `dp_${piId}`,
      stripeReason: 'fraudulent',
      amountCents: 505_000,
      livemode: false,
    });
    expect(rows[0]!.evidenceDueAt?.getTime()).toBe(DUE_BY * 1000);
    expect(rows[0]!.slaDueAt.getTime()).toBe(DUE_BY * 1000);

    const invoice = await commission.getById(invoiceId);
    expect(invoice.chargebackStatus).toBe('open');
    expect(invoice.status).toBe('paid');

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toContain('Chargeback opened');
    expect(alerts[0]!.title).toContain('Dec 7, 2026');
    expect(alerts[0]!.summary).toContain('Stripe dashboard');

    expect(await auditsFor(rows[0]!.id)).toEqual(['chargeback.opened']);
    expect(await auditsFor(invoiceId)).toContain('invoice.chargeback_opened');

    // Redelivery (same event) and a re-run of the handler change nothing.
    const again = await deliver(created);
    expect(again.duplicate).toBe(true);
    const rerun = await chargebacks.handleDisputeEvent({
      eventId: 'evt_rerun',
      eventType: 'charge.dispute.created',
      paymentIntentId: piId,
      dispute: normalizeStripeEvent(created as never).dispute!,
    });
    expect(rerun.changed).toBe(false);
    expect(await chargebackRows(invoiceId)).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('charge.dispute.updated moves the evidence deadline (and SLA) with an audit row', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    const later = DUE_BY + 2 * 86_400;
    await deliver(
      disputeEvent('charge.dispute.updated', piId, {
        status: 'under_review',
        evidence_details: { due_by: later },
      }),
    );
    const [row] = await chargebackRows(invoiceId);
    expect(row).toMatchObject({ stripeStatus: 'under_review', status: 'open' });
    expect(row!.slaDueAt.getTime()).toBe(later * 1000);
    expect(await auditsFor(row!.id)).toEqual(['chargeback.opened', 'chargeback.updated']);
  });

  it('funds_withdrawn / funds_reinstated each append one audit row (deduped per event)', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    const withdrawn = disputeEvent('charge.dispute.funds_withdrawn', piId);
    await deliver(withdrawn);
    const dispute = normalizeStripeEvent(withdrawn as never).dispute!;
    // A handler re-run for the same Stripe event (claimed-but-unprocessed
    // redelivery) must not write a second row.
    await chargebacks.handleDisputeEvent({
      eventId: (withdrawn as { id: string }).id,
      eventType: 'charge.dispute.funds_withdrawn',
      paymentIntentId: piId,
      dispute,
    });
    await deliver(disputeEvent('charge.dispute.funds_reinstated', piId));
    const [row] = await chargebackRows(invoiceId);
    expect(await auditsFor(row!.id)).toEqual([
      'chargeback.opened',
      'chargeback.funds_withdrawn',
      'chargeback.funds_reinstated',
    ]);
  });

  it.each(['lost', 'won', 'warning_closed'] as const)(
    'AC3: charge.dispute.closed (%s) records the outcome once; redelivery is a no-op',
    async (outcome) => {
      const { invoiceId, piId } = await paidInvoice();
      await deliver(disputeEvent('charge.dispute.created', piId));
      alerts.length = 0;
      const closed = disputeEvent('charge.dispute.closed', piId, { status: outcome });
      await deliver(closed);

      const invoice = await commission.getById(invoiceId);
      expect(invoice.chargebackStatus).toBe(outcome);
      // #873: lost → the commission is owed again (failed = dunning);
      // won / warning_closed leave the invoice paid.
      expect(invoice.status).toBe(outcome === 'lost' ? 'failed' : 'paid');
      expect(failedEmails.map((e) => e.reason)).toEqual(
        outcome === 'lost' ? ['chargeback_lost'] : [],
      );
      const [row] = await chargebackRows(invoiceId);
      expect(row).toMatchObject({ status: 'closed', outcome, resolvedBy: 'stripe' });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.title).toContain(outcome === 'lost' ? 'Chargeback lost' : 'Chargeback closed');

      const invoiceAudits = await auditsFor(invoiceId);
      expect(invoiceAudits.filter((t) => t === 'invoice.chargeback_closed')).toHaveLength(1);

      // Redelivery as a new handler run (same payload) → nothing changes.
      const before = (await testDb.db.select().from(billingEvents)).length;
      const rerun = await chargebacks.handleDisputeEvent({
        eventId: (closed as { id: string }).id,
        eventType: 'charge.dispute.closed',
        paymentIntentId: piId,
        dispute: normalizeStripeEvent(closed as never).dispute!,
      });
      expect(rerun.changed).toBe(false);
      expect((await testDb.db.select().from(billingEvents)).length).toBe(before);
      expect(alerts).toHaveLength(1);
      expect(failedEmails).toHaveLength(outcome === 'lost' ? 1 : 0);
      // A late, out-of-order update never re-opens it.
      await deliver(disputeEvent('charge.dispute.updated', piId, { status: 'under_review' }));
      expect((await commission.getById(invoiceId)).chargebackStatus).toBe(outcome);
    },
  );

  /** A chargeback service whose audit.append throws once for `failOn`. */
  function flakyChargebacks(failOn: string): ChargebackService {
    let failed = false;
    const flakyAudit: BillingAuditService = {
      ...audit,
      append: async (input) => {
        if (!failed && input.eventType === failOn) {
          failed = true;
          throw new Error(`injected failure on ${failOn}`);
        }
        return audit.append(input);
      },
    };
    return createChargebackService({
      db: testDb.db,
      audit: flakyAudit,
      commission,
      email: fakeEmail(),
      opsInbox: 'ops@example.com',
      now: () => NOW,
      newId: nextId,
      logWarning: () => undefined,
    });
  }

  it('AC1 repair: a failure after the chargeback insert still alerts on redelivery', async () => {
    const { invoiceId, piId } = await paidInvoice();
    const service = flakyChargebacks('chargeback.opened');
    const created = disputeEvent('charge.dispute.created', piId);
    const input = {
      eventId: (created as { id: string }).id,
      eventType: 'charge.dispute.created' as const,
      paymentIntentId: piId,
      dispute: normalizeStripeEvent(created as never).dispute!,
    };
    await expect(service.handleDisputeEvent(input)).rejects.toThrow('injected failure');
    expect(await chargebackRows(invoiceId)).toHaveLength(1);

    alerts.length = 0;
    const redelivered = await service.handleDisputeEvent(input);
    expect(redelivered.changed).toBe(true);
    // At-least-once: the redelivery sends the deadline alert.
    expect(alerts.filter((a) => a.title.includes('Chargeback opened'))).toHaveLength(1);
    const [row] = await chargebackRows(invoiceId);
    expect(await auditsFor(row!.id)).toEqual(['chargeback.opened']);
    expect((await commission.getById(invoiceId)).chargebackStatus).toBe('open');

    // A further redelivery is a no-op.
    alerts.length = 0;
    expect((await service.handleDisputeEvent(input)).changed).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it('AC3 repair: a failure after the dispute row closes still reconciles the invoice on redelivery', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    const service = flakyChargebacks('chargeback.closed');
    const closed = disputeEvent('charge.dispute.closed', piId, { status: 'lost' });
    const input = {
      eventId: (closed as { id: string }).id,
      eventType: 'charge.dispute.closed' as const,
      paymentIntentId: piId,
      dispute: normalizeStripeEvent(closed as never).dispute!,
    };
    alerts.length = 0;
    await expect(service.handleDisputeEvent(input)).rejects.toThrow('injected failure');
    const [rowAfterFailure] = await chargebackRows(invoiceId);
    expect(rowAfterFailure).toMatchObject({ status: 'closed', outcome: 'lost' });
    expect((await commission.getById(invoiceId)).chargebackStatus).toBe('open');
    expect(alerts).toHaveLength(0);

    const redelivered = await service.handleDisputeEvent(input);
    expect(redelivered.changed).toBe(true);
    expect((await commission.getById(invoiceId)).chargebackStatus).toBe('lost');
    expect(alerts.map((a) => a.title)).toEqual([expect.stringContaining('Chargeback lost')]);
    expect(await auditsFor(rowAfterFailure!.id)).toEqual(['chargeback.opened', 'chargeback.closed']);
    expect(
      (await auditsFor(invoiceId)).filter((t) => t === 'invoice.chargeback_closed'),
    ).toHaveLength(1);

    // A further redelivery is a no-op.
    expect((await service.handleDisputeEvent(input)).changed).toBe(false);
    expect(alerts).toHaveLength(1);

    // retryCharge is no longer blocked by a stale 'open' flag.
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'failed' })
      .where(eq(commissionInvoices.id, invoiceId));
    const retryError = await commission.retryCharge(invoiceId).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String((retryError as Error | undefined)?.message ?? '')).not.toContain('open chargeback');

  });

  it('a late updated event does not overwrite a closed chargeback', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    await deliver(disputeEvent('charge.dispute.closed', piId, { status: 'won' }));
    await deliver(
      disputeEvent('charge.dispute.updated', piId, {
        status: 'under_review',
        amount: 1,
        evidence_details: { due_by: DUE_BY + 86_400 },
      }),
    );
    const [row] = await chargebackRows(invoiceId);
    expect(row).toMatchObject({ status: 'closed', outcome: 'won', stripeStatus: 'won', amountCents: 505_000 });
    expect(row!.evidenceDueAt?.getTime()).toBe(DUE_BY * 1000);
  });

  async function invoiceAuditRows(invoiceId: string) {
    return testDb.db.select().from(billingEvents).where(eq(billingEvents.entityId, invoiceId));
  }

  it('#873: a lost chargeback re-opens the invoice for dunning; retryCharge re-collects; late events still map', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    await deliver(disputeEvent('charge.dispute.closed', piId, { status: 'lost' }));

    const reopened = await commission.getById(invoiceId);
    expect(reopened).toMatchObject({ status: 'failed', chargebackStatus: 'lost', paidAt: null });
    const [cb] = await chargebackRows(invoiceId);
    const rows = await invoiceAuditRows(invoiceId);
    const failedRow = rows.find(
      (r) => r.eventType === 'invoice.charge_failed' &&
        (r.payload as Record<string, unknown>)['source'] === 'chargeback_lost',
    );
    expect(failedRow?.payload).toMatchObject({
      status: 'failed',
      previousStatus: 'paid',
      disputeId: cb!.id,
      stripeDisputeId: `dp_${piId}`,
      paymentIntentId: piId,
    });
    const closedRow = rows.find((r) => r.eventType === 'invoice.chargeback_closed');
    expect(closedRow?.payload).toMatchObject({ status: 'failed', recollect: true });
    expect(alerts.map((a) => a.title)).toEqual(
      expect.arrayContaining([expect.stringContaining('commission due again')]),
    );
    expect(failedEmails).toEqual([
      { to: expect.stringContaining('@') as unknown as string, reason: 'chargeback_lost' },
    ]);

    // Normal dunning: an admin retry charges a fresh PaymentIntent.
    const retried = await commission.retryCharge(invoiceId);
    expect(retried.status).toBe('finalized');
    expect(retried.stripePaymentIntentId).not.toBe(piId);

    // A late event for the ORIGINAL charge still finds the invoice through
    // the chargeback row — not an orphan, and the invoice is untouched.
    await deliver(disputeEvent('charge.dispute.funds_withdrawn', piId));
    expect(await auditsFor(cb!.id)).toContain('chargeback.funds_withdrawn');
    const orphans = (await testDb.db.select().from(billingEvents)).filter(
      (r) =>
        r.eventType === 'webhook.orphan_payment_intent' &&
        (r.payload as Record<string, unknown>)['paymentIntentId'] === piId,
    );
    expect(orphans).toEqual([]);
    expect((await commission.getById(invoiceId)).status).toBe('finalized');

    await commission.markPaidByPaymentIntent(retried.stripePaymentIntentId!);
    expect((await commission.getById(invoiceId)).status).toBe('paid');
  });

  it('#873: a partial lost chargeback is left paid for manual follow-up (no over-collection)', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId, { amount: 100_000 }));
    await deliver(disputeEvent('charge.dispute.closed', piId, { status: 'lost', amount: 100_000 }));
    const invoice = await commission.getById(invoiceId);
    expect(invoice).toMatchObject({ status: 'paid', chargebackStatus: 'lost' });
    expect(failedEmails).toEqual([]);
    expect(alerts.map((a) => a.title)).toEqual(
      expect.arrayContaining([expect.stringContaining('manual follow-up')]),
    );
    const closedRow = (await invoiceAuditRows(invoiceId)).find(
      (r) => r.eventType === 'invoice.chargeback_closed',
    );
    expect(closedRow?.payload).toMatchObject({ status: 'paid', manualFollowUpRequired: true });
  });

  it('#873: a lost chargeback on a partly refunded invoice is left for manual follow-up', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(refundEvent(piId, 5_000));
    await deliver(disputeEvent('charge.dispute.created', piId));
    await deliver(disputeEvent('charge.dispute.closed', piId, { status: 'lost' }));
    expect((await commission.getById(invoiceId)).status).toBe('paid');
    expect(failedEmails).toEqual([]);
  });

  it('#873: reopenAfterLostChargeback finishes a partly applied move once, then no-ops', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    const [cb] = await chargebackRows(invoiceId);
    // Simulate a delivery that moved the invoice but died before the audit.
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'failed', paidAt: null, chargebackStatus: 'lost' })
      .where(eq(commissionInvoices.id, invoiceId));
    const input = {
      invoiceId,
      disputeId: cb!.id,
      stripeDisputeId: cb!.stripeDisputeId,
      stripeEventId: 'evt_repair',
    };
    expect(await commission.reopenAfterLostChargeback(input)).toEqual({ reopened: true });
    expect(await commission.reopenAfterLostChargeback(input)).toEqual({ reopened: false });
    const failedRows = (await invoiceAuditRows(invoiceId)).filter(
      (r) => r.eventType === 'invoice.charge_failed',
    );
    expect(failedRows).toHaveLength(1);
    expect(failedEmails.map((e) => e.reason)).toEqual(['chargeback_lost']);

    // A void (written-off) invoice is never re-opened.
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'void' })
      .where(eq(commissionInvoices.id, invoiceId));
    expect(
      await commission.reopenAfterLostChargeback({ ...input, disputeId: nextId() }),
    ).toEqual({ reopened: false });
  });

  it('#873: a redelivered lost close after the invoice was re-collected does not reopen it again', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    const closeId = nextEventId();
    const closed = disputeEvent('charge.dispute.closed', piId, { status: 'lost' }, closeId);
    await deliver(closed);
    expect((await commission.getById(invoiceId)).status).toBe('failed');
    expect(failedEmails.map((e) => e.reason)).toEqual(['chargeback_lost']);

    // Invoice collected again (admin retry / builder pay) while the first
    // delivery is still unfinished from Stripe's view (processed_at null).
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'paid', paidAt: NOW })
      .where(eq(commissionInvoices.id, invoiceId));
    await testDb.db
      .update(stripeEvents)
      .set({ processedAt: null })
      .where(eq(stripeEvents.eventId, closeId));

    await deliver(closed);
    expect((await commission.getById(invoiceId)).status).toBe('paid');
    expect(failedEmails.map((e) => e.reason)).toEqual(['chargeback_lost']);
    const failedRows = (await invoiceAuditRows(invoiceId)).filter(
      (r) => r.eventType === 'invoice.charge_failed',
    );
    expect(failedRows).toHaveLength(1);
  });

  it('#873: an open chargeback flags the builder in the admin list (nothing is paused)', async () => {
    const { tenantKey, piId } = await paidInvoice();
    await testDb.db.insert(builders).values({
      id: nextId(),
      tenantKey,
      businessName: `${tenantKey} Builder`,
      displayName: tenantKey,
    });
    const builderService = createBuilderService({
      db: testDb.db,
      audit: { log: async () => undefined } as unknown as AdminAuditStore,
    });
    const flag = async () =>
      (await builderService.listBuilders()).find((b) => b.tenantKey === tenantKey);
    expect(await flag()).toMatchObject({ openChargebacks: 0, status: 'active' });
    await deliver(disputeEvent('charge.dispute.created', piId));
    expect(await flag()).toMatchObject({ openChargebacks: 1, status: 'active' });
    expect(alerts[0]!.summary).toContain('pause the builder by hand');
    await deliver(disputeEvent('charge.dispute.closed', piId, { status: 'won' }));
    expect(await flag()).toMatchObject({ openChargebacks: 0, status: 'active' });
  });

  it('an out-of-order close (no created seen) still records and closes the chargeback', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.closed', piId, { status: 'lost' }));
    const rows = await chargebackRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'closed', outcome: 'lost' });
    expect((await commission.getById(invoiceId)).chargebackStatus).toBe('lost');
  });

  it('AC4: charge.refunded mirrors the cumulative refunded amount with a timeline row', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(refundEvent(piId, 100_000));
    expect((await commission.getById(invoiceId)).refundedCents).toBe(100_000);
    await deliver(refundEvent(piId, 505_000));
    const invoice = await commission.getById(invoiceId);
    expect(invoice.refundedCents).toBe(505_000);
    // Stale (lower) and repeated amounts are no-ops.
    await deliver(refundEvent(piId, 100_000));
    await deliver(refundEvent(piId, 505_000));
    expect((await commission.getById(invoiceId)).refundedCents).toBe(505_000);
    const refunds = (
      await testDb.db.select().from(billingEvents).where(eq(billingEvents.entityId, invoiceId))
    ).filter((r) => r.eventType === 'invoice.refunded');
    expect(refunds.map((r) => (r.payload as Record<string, unknown>)['deltaCents'])).toEqual([
      100_000, 405_000,
    ]);
    expect((refunds[1]!.payload as Record<string, unknown>)['fullyRefunded']).toBe(true);
  });

  it('AC5: none of the #719 event types is recorded as webhook.unhandled', async () => {
    const { piId } = await paidInvoice();
    for (const type of [
      'charge.dispute.created',
      'charge.dispute.updated',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.funds_reinstated',
      'charge.dispute.closed',
    ]) {
      await deliver(disputeEvent(type, piId, type === 'charge.dispute.closed' ? { status: 'won' } : {}));
    }
    await deliver(refundEvent(piId, 1_000));
    const unhandled = (await testDb.db.select().from(billingEvents))
      .filter((r) => r.eventType === 'webhook.unhandled')
      .map((r) => (r.payload as Record<string, unknown>)['stripeType']);
    expect(unhandled).toEqual([]);
  });

  it('a dispute for a PaymentIntent no invoice owns is an orphan (audited + alerted, 200)', async () => {
    const res = await deliver(disputeEvent('charge.dispute.created', 'pi_unknown_cb'));
    expect(res).toEqual({ received: true, duplicate: false });
    const orphan = (await testDb.db.select().from(billingEvents)).filter(
      (r) => r.eventType === 'webhook.orphan_payment_intent',
    );
    expect(orphan.map((r) => (r.payload as Record<string, unknown>)['paymentIntentId'])).toContain(
      'pi_unknown_cb',
    );
    expect(alerts).toHaveLength(1);
  });

  it('a charge with no PaymentIntent is acknowledged as ignored, not unhandled', async () => {
    const eventId = nextEventId();
    await deliver({ id: eventId, type: 'charge.refunded', data: { object: { id: 'ch_x', amount_refunded: 5 } } });
    const rows = (await testDb.db.select().from(billingEvents)).filter((r) => r.entityId === eventId);
    // Unordered select + identical frozen timestamps: compare as a set.
    expect(rows.map((r) => r.eventType).sort()).toEqual(['webhook.ignored', 'webhook.received']);
  });

  it('AC2: the disputes console lists the chargeback distinctly and refuses accept/reject', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    const list = await disputes.listOpenDisputes(NOW);
    const item = list.find((d) => d.invoiceId === invoiceId);
    expect(item).toMatchObject({
      source: 'chargeback',
      stripeReason: 'fraudulent',
      amountCents: 505_000,
      evidenceDaysRemaining: 21,
      breached: false,
      livemode: false,
    });
    expect(item!.slaDueAt.getTime()).toBe(DUE_BY * 1000);
    await expect(disputes.acceptDispute(item!.id, { adminEmail: 'a@example.com' })).rejects.toMatchObject({
      status: 409,
    });
    await expect(disputes.rejectDispute(item!.id, { adminEmail: 'a@example.com' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('a builder dispute on the same invoice is not confused with the chargeback row', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    const invoice = await commission.getById(invoiceId);
    const builderDispute = await disputes.recordOpenedDispute({ ...invoice, disputeReason: 'Wrong lead' });
    expect(builderDispute.source).toBe('builder');
    expect(await chargebackRows(invoiceId)).toHaveLength(2);
  });

  it('retryCharge refuses while a chargeback is open', async () => {
    const { invoiceId, piId } = await paidInvoice();
    await deliver(disputeEvent('charge.dispute.created', piId));
    // Force the edge case: the invoice is retryable by status.
    await testDb.db
      .update(commissionInvoices)
      .set({ status: 'failed' })
      .where(eq(commissionInvoices.id, invoiceId));
    await expect(commission.retryCharge(invoiceId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('open chargeback'),
    });
  });
});
