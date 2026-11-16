/**
 * Simulated payment provider unit tests (#753).
 *
 * The in-memory store and a captured webhook deliverer stand in for
 * Postgres and the webhook route; the PaymentProvider contract (Stripe
 * shapes, statuses, decline messages, idempotency, signatures) is checked
 * directly. The production-handler path is covered by
 * simulated-payments.webhook.integration.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIMULATED_TEST_CARDS } from '@feasly/contracts';
import {
  createSimulatedPaymentProvider,
  signSimulatedPayload,
  type SimulatedPaymentProvider,
} from '../src/services/billing/simulated-payment.provider';
import { createInMemorySimulatedPaymentStore } from '../src/services/billing/simulated-payment.store';
import type { NormalizedStripeEvent } from '../src/services/billing/payment-provider';

const SECRET = 'whsec_sim_unit_test_secret';
const CARD = {
  ok: '4242424242424242',
  declined: '4000000000000002',
  noFunds: '4000000000009995',
  threeDs: '4000002760003184',
};

interface Harness {
  provider: SimulatedPaymentProvider;
  delivered: NormalizedStripeEvent[];
  /** Run scheduled (delayed) deliveries. */
  runTimers(): Promise<void>;
  clock: { now: Date };
  failDeliveries: { on: boolean };
}

const providers: SimulatedPaymentProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

function harness(): Harness {
  const clock = { now: new Date('2026-11-15T12:00:00.000Z') };
  const scheduled: Array<() => void> = [];
  const delivered: NormalizedStripeEvent[] = [];
  const failDeliveries = { on: false };
  const provider = createSimulatedPaymentProvider({
    store: createInMemorySimulatedPaymentStore(),
    webhookSecret: SECRET,
    deliveryDelayMs: 1_000,
    now: () => clock.now,
    schedule: (run) => {
      scheduled.push(run);
      return () => undefined;
    },
    logWarning: () => undefined,
  });
  providers.push(provider);
  provider.connectWebhook(async (body, signature) => {
    if (failDeliveries.on) throw new Error('handler down');
    // Verify exactly like StripeService.verifyWebhook does.
    delivered.push(provider.constructWebhookEvent(body, signature, SECRET));
  });
  return {
    provider,
    delivered,
    clock,
    failDeliveries,
    async runTimers() {
      // The delay has elapsed by the time the timer fires.
      clock.now = new Date(clock.now.getTime() + 1_000);
      for (const run of scheduled.splice(0)) run();
      await provider.deliverPendingEvents();
    },
  };
}

async function customerWithCard(
  h: Harness,
  card: string,
  tenantKey = 'acme',
): Promise<string> {
  const { id: customerId } = await h.provider.createCustomer(
    { tenantKey },
    `feasly-customer-${tenantKey}`,
  );
  const si = await h.provider.createSetupIntent(customerId);
  const res = await h.provider.confirmSetupIntent(si.id, card);
  if (res.status === 'requires_action') {
    await h.provider.authenticateIntent(si.id, 'complete');
  }
  return customerId;
}

const charge = (h: Harness, customerId: string, key = 'charge-1') =>
  h.provider.createOffSessionPaymentIntent(
    { amountCents: 12_345, currency: 'CAD', customerId, description: 'test' },
    key,
  );

describe('simulated payment provider — customers and cards', () => {
  it('creates a Stripe-shaped customer idempotently', async () => {
    const h = harness();
    const a = await h.provider.createCustomer({ tenantKey: 't' }, 'k1');
    const b = await h.provider.createCustomer({ tenantKey: 't' }, 'k1');
    expect(a.id).toMatch(/^cus_sim_/);
    expect(b.id).toBe(a.id);
  });

  it('saves a test card via SetupIntent and lists display-safe fields only', async () => {
    const h = harness();
    const { id: customerId } = await h.provider.createCustomer({ tenantKey: 't' }, 'k');
    const si = await h.provider.createSetupIntent(customerId);
    expect(si.id).toMatch(/^seti_sim_/);
    expect(si.clientSecret).toContain(`${si.id}_secret_`);
    const res = await h.provider.confirmSetupIntent(si.id, '4242 4242 4242 4242');
    expect(res).toEqual({ intentId: si.id, status: 'succeeded' });
    const cards = await h.provider.listPaymentMethods(customerId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ brand: 'visa', last4: '4242', expMonth: 12 });
    expect(cards[0]!.id).toMatch(/^pm_sim_/);
    expect(JSON.stringify(cards)).not.toContain('4242424242424242');
    expect(h.delivered.map((e) => e.type)).toEqual([
      'payment_method.attached',
      'setup_intent.succeeded',
    ]);
    expect(h.delivered[0]).toMatchObject({ customerId, paymentMethodId: cards[0]!.id });
  });

  it('rejects anything that is not a listed test card', async () => {
    const h = harness();
    const { id: customerId } = await h.provider.createCustomer({ tenantKey: 't' }, 'k');
    const si = await h.provider.createSetupIntent(customerId);
    await expect(
      h.provider.confirmSetupIntent(si.id, '5555555555554444'),
    ).rejects.toMatchObject({ status: 422 });
    expect(await h.provider.listPaymentMethods(customerId)).toHaveLength(0);
  });

  it('a SetupIntent cannot be confirmed twice', async () => {
    const h = harness();
    const { id: customerId } = await h.provider.createCustomer({ tenantKey: 't' }, 'k');
    const si = await h.provider.createSetupIntent(customerId);
    await h.provider.confirmSetupIntent(si.id, CARD.ok);
    await expect(h.provider.confirmSetupIntent(si.id, CARD.ok)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('3DS card: setup requires_action, completing the challenge attaches the card', async () => {
    const h = harness();
    const { id: customerId } = await h.provider.createCustomer({ tenantKey: 't' }, 'k');
    const si = await h.provider.createSetupIntent(customerId);
    const pending = await h.provider.confirmSetupIntent(si.id, CARD.threeDs);
    expect(pending).toEqual({
      intentId: si.id,
      status: 'requires_action',
      nextAction: 'three_d_secure',
    });
    expect(await h.provider.listPaymentMethods(customerId)).toHaveLength(0);
    const done = await h.provider.authenticateIntent(si.id, 'complete');
    expect(done.status).toBe('succeeded');
    const cards = await h.provider.listPaymentMethods(customerId);
    expect(cards.map((c) => c.last4)).toEqual(['3184']);
  });

  it('3DS card: a failed challenge leaves no card and reports Stripe’s error', async () => {
    const h = harness();
    const { id: customerId } = await h.provider.createCustomer({ tenantKey: 't' }, 'k');
    const si = await h.provider.createSetupIntent(customerId);
    await h.provider.confirmSetupIntent(si.id, CARD.threeDs);
    const failed = await h.provider.authenticateIntent(si.id, 'fail');
    expect(failed.status).toBe('requires_payment_method');
    expect(failed.lastErrorMessage).toMatch(/authentication failed/);
    expect(await h.provider.listPaymentMethods(customerId)).toHaveLength(0);
    expect(h.delivered.at(-1)?.type).toBe('setup_intent.setup_failed');
  });

  it('lists the newest card first and detaches cards', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.declined);
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const si = await h.provider.createSetupIntent(customerId);
    await h.provider.confirmSetupIntent(si.id, CARD.ok);
    const cards = await h.provider.listPaymentMethods(customerId);
    expect(cards.map((c) => c.last4)).toEqual(['4242', '0002']);
    await h.provider.detachPaymentMethod(cards[0]!.id!);
    expect((await h.provider.listPaymentMethods(customerId)).map((c) => c.last4)).toEqual([
      '0002',
    ]);
    await h.runTimers();
    expect(h.delivered.at(-1)?.type).toBe('payment_method.detached');
  });

  it('every listed test card is accepted for setup', async () => {
    for (const card of SIMULATED_TEST_CARDS) {
      const h = harness();
      const customerId = await customerWithCard(h, card.number);
      expect(await h.provider.listPaymentMethods(customerId)).toHaveLength(1);
    }
  });
});

describe('simulated payment provider — default card and customer details (#716)', () => {
  it('charges the default card, not the newest, once a default is set', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const [okCard] = await h.provider.listPaymentMethods(customerId);
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const si = await h.provider.createSetupIntent(customerId);
    await h.provider.confirmSetupIntent(si.id, CARD.declined);
    // Without a default, the newest (declining) card would be charged.
    await h.provider.setDefaultPaymentMethod(customerId, okCard!.id!);
    expect(await h.provider.getDefaultPaymentMethodId(customerId)).toBe(okCard!.id);
    const pi = await charge(h, customerId);
    expect(pi.status).toBe('succeeded');
  });

  it('records the statement descriptor suffix on the PaymentIntent', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    h.delivered.length = 0;
    await h.provider.createOffSessionPaymentIntent(
      {
        amountCents: 100,
        currency: 'CAD',
        customerId,
        description: 'test',
        statementDescriptorSuffix: 'FEASLY COMMISSION',
      },
      'descriptor-1',
    );
    await h.runTimers();
    expect(h.delivered.map((e) => e.type)).toContain('payment_intent.succeeded');
  });

  it('rejects a default card that belongs to another customer', async () => {
    const h = harness();
    const a = await customerWithCard(h, CARD.ok, 'a');
    const b = await customerWithCard(h, CARD.ok, 'b');
    const [bCard] = await h.provider.listPaymentMethods(b);
    await expect(h.provider.setDefaultPaymentMethod(a, bCard!.id!)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('detaching the default card clears the default', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const [card] = await h.provider.listPaymentMethods(customerId);
    await h.provider.setDefaultPaymentMethod(customerId, card!.id!);
    await h.provider.detachPaymentMethod(card!.id!);
    expect(await h.provider.getDefaultPaymentMethodId(customerId)).toBeNull();
    await h.runTimers();
    expect(h.delivered.at(-1)).toMatchObject({
      type: 'payment_method.detached',
      customerId,
      paymentMethodId: card!.id,
    });
  });

  it('setup_intent.succeeded carries the saved card id', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const [card] = await h.provider.listPaymentMethods(customerId);
    expect(h.delivered.find((e) => e.type === 'setup_intent.succeeded')).toMatchObject({
      customerId,
      paymentMethodId: card!.id,
    });
  });

  it('stores and updates the business name and builder id', async () => {
    const h = harness();
    const { id } = await h.provider.createCustomer(
      { tenantKey: 't', name: 'Elite Craft Builders', builderId: 'b-1' },
      'k',
    );
    await h.provider.updateCustomer(id, { tenantKey: 't', name: 'Elite Craft Ltd', builderId: 'b-1' });
    await h.provider.deliverPendingEvents();
    expect(h.delivered.at(-1)).toMatchObject({ type: 'customer.updated', customerId: id });
    expect(await h.provider.getDefaultPaymentMethodId(id)).toBeNull();
    expect(await h.provider.getDefaultPaymentMethodId('cus_unknown')).toBeNull();
  });
});

describe('simulated payment provider — off-session charges', () => {
  it('4242 succeeds; the webhook is delivered only after the delay', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    h.delivered.length = 0;
    const pi = await charge(h, customerId);
    expect(pi.id).toMatch(/^pi_sim_/);
    expect(pi.status).toBe('succeeded');
    expect(h.delivered).toHaveLength(0);
    await h.runTimers();
    expect(h.delivered).toEqual([
      expect.objectContaining({
        type: 'payment_intent.succeeded',
        paymentIntentId: pi.id,
        customerId,
      }),
    ]);
    expect(await h.provider.retrievePaymentIntent(pi.id)).toEqual({
      id: pi.id,
      status: 'succeeded',
    });
  });

  it('the same idempotency key never charges twice', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    h.delivered.length = 0;
    const a = await charge(h, customerId, 'invoice-1:charge');
    const b = await charge(h, customerId, 'invoice-1:charge');
    expect(b).toEqual(a);
    await h.runTimers();
    expect(h.delivered).toHaveLength(1);
    const c = await charge(h, customerId, 'invoice-1:retry:1');
    expect(c.id).not.toBe(a.id);
  });

  it.each([
    [CARD.declined, 'Your card was declined.'],
    [CARD.noFunds, 'Your card has insufficient funds.'],
  ])('%s declines as a status (not a throw) with Stripe’s message', async (card, message) => {
    const h = harness();
    const customerId = await customerWithCard(h, card);
    h.delivered.length = 0;
    const pi = await charge(h, customerId);
    expect(pi.status).toBe('requires_payment_method');
    await h.runTimers();
    expect(h.delivered).toEqual([
      expect.objectContaining({
        type: 'payment_intent.payment_failed',
        paymentIntentId: pi.id,
        failureMessage: message,
      }),
    ]);
    expect(await h.provider.retrievePaymentIntent(pi.id)).toEqual({
      id: pi.id,
      status: 'requires_payment_method',
      lastPaymentErrorMessage: message,
    });
  });

  it('3DS card: requires_action, then completing the challenge succeeds', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.threeDs);
    h.delivered.length = 0;
    const pi = await charge(h, customerId);
    expect(pi.status).toBe('requires_action');
    const done = await h.provider.authenticateIntent(pi.id, 'complete');
    expect(done).toEqual({ intentId: pi.id, status: 'succeeded' });
    expect(h.delivered.map((e) => e.type)).toEqual([
      'payment_intent.requires_action',
      'payment_intent.succeeded',
    ]);
  });

  it('3DS card: failing the challenge fails the payment', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.threeDs);
    const pi = await charge(h, customerId);
    const failed = await h.provider.authenticateIntent(pi.id, 'fail');
    expect(failed.status).toBe('requires_payment_method');
    expect(h.delivered.at(-1)).toMatchObject({
      type: 'payment_intent.payment_failed',
      paymentIntentId: pi.id,
    });
  });

  it('no card on file → 422 like the Stripe provider', async () => {
    const h = harness();
    const { id: customerId } = await h.provider.createCustomer({ tenantKey: 't' }, 'k');
    await expect(charge(h, customerId)).rejects.toMatchObject({
      status: 422,
      code: 'BILLING_NOT_CONFIGURED',
    });
  });

  it('a 3DS challenge can only be completed while requires_action', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const pi = await charge(h, customerId);
    await expect(h.provider.authenticateIntent(pi.id, 'complete')).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      h.provider.authenticateIntent('pi_sim_missing', 'complete'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('simulated payment provider — refunds, disputes, delayed failures', () => {
  it('refunds partially then fully, emitting charge.refunded each time', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const pi = await charge(h, customerId);
    await h.runTimers();
    h.delivered.length = 0;
    const partial = await h.provider.refundPaymentIntent(pi.id, 'r1', 2_345);
    expect(partial).toEqual({ id: expect.stringMatching(/^re_sim_/), status: 'succeeded' });
    // Same key replays the first refund.
    expect(await h.provider.refundPaymentIntent(pi.id, 'r1', 2_345)).toEqual(partial);
    await expect(h.provider.refundPaymentIntent(pi.id, 'r2', 10_001)).rejects.toMatchObject({
      status: 422,
    });
    await h.provider.refundPaymentIntent(pi.id, 'r3');
    await expect(h.provider.refundPaymentIntent(pi.id, 'r4')).rejects.toMatchObject({
      status: 422,
    });
    await h.runTimers();
    expect(h.delivered.map((e) => [e.type, e.paymentIntentId])).toEqual([
      ['charge.refunded', pi.id],
      ['charge.refunded', pi.id],
    ]);
  });

  it('only a succeeded charge can be refunded or disputed', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.declined);
    const pi = await charge(h, customerId);
    await expect(h.provider.refundPaymentIntent(pi.id, 'r')).rejects.toMatchObject({
      status: 409,
    });
    await expect(h.provider.fireDispute(pi.id)).rejects.toMatchObject({ status: 409 });
  });

  it('fireDispute delivers charge.dispute.created immediately', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const pi = await charge(h, customerId);
    const res = await h.provider.fireDispute(pi.id);
    expect(res.eventType).toBe('charge.dispute.created');
    // The pending charge event is flushed first, in order.
    // Stripe withdraws the funds right after opening (#719).
    expect(h.delivered.slice(-3).map((e) => e.type)).toEqual([
      'payment_intent.succeeded',
      'charge.dispute.created',
      'charge.dispute.funds_withdrawn',
    ]);
    const created = h.delivered.at(-2);
    expect(created?.paymentIntentId).toBe(pi.id);
    // #719: Stripe-shaped dispute with an evidence deadline.
    expect(created?.dispute).toMatchObject({ reason: 'fraudulent', status: 'needs_response' });
    expect(created?.dispute?.evidenceDueAt).toBeInstanceOf(Date);
  });

  it('fireDisputeClosed closes the open dispute (won reinstates funds first)', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const pi = await charge(h, customerId);
    await expect(h.provider.fireDisputeClosed(pi.id, 'won')).rejects.toMatchObject({ status: 409 });
    await h.provider.fireDispute(pi.id);
    const res = await h.provider.fireDisputeClosed(pi.id, 'won');
    expect(res.eventType).toBe('charge.dispute.closed');
    expect(h.delivered.slice(-2).map((e) => [e.type, e.dispute?.status])).toEqual([
      ['charge.dispute.funds_reinstated', 'won'],
      ['charge.dispute.closed', 'won'],
    ]);
    // Already closed — nothing left to close.
    await expect(h.provider.fireDisputeClosed(pi.id, 'lost')).rejects.toMatchObject({ status: 409 });
  });

  it('fireDashboardRefund refunds and delivers at once', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    const pi = await charge(h, customerId);
    await h.provider.fireDashboardRefund(pi.id, 100);
    expect(h.delivered.at(-1)).toMatchObject({
      type: 'charge.refunded',
      paymentIntentId: pi.id,
    });
  });

  it('fireDelayedFailure fails an in-flight charge and refuses a settled one', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.threeDs);
    const pi = await charge(h, customerId);
    await h.provider.fireDelayedFailure(pi.id);
    expect(h.delivered.at(-1)).toMatchObject({
      type: 'payment_intent.payment_failed',
      failureMessage: 'Your card was declined.',
    });
    await expect(h.provider.fireDelayedFailure(pi.id)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('simulated payment provider — subscriptions', () => {
  it('a paying card activates the subscription; cancel emits deleted', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    h.delivered.length = 0;
    const sub = await h.provider.createSubscription({ customerId, priceId: 'price_x' });
    expect(sub.status).toBe('active');
    await h.provider.cancelSubscription(sub.id);
    await h.runTimers();
    expect(h.delivered.map((e) => e.type)).toEqual([
      'customer.subscription.created',
      'invoice.payment_succeeded',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]);
    expect(h.delivered[1]).toMatchObject({ subscriptionId: sub.id, customerId });
  });

  it('a declining card leaves it incomplete with invoice.payment_failed', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.noFunds);
    h.delivered.length = 0;
    const sub = await h.provider.createSubscription({ customerId, priceId: 'price_x' });
    expect(sub.status).toBe('incomplete');
    await h.runTimers();
    expect(h.delivered.map((e) => e.type)).toContain('invoice.payment_failed');
  });
});

describe('simulated payment provider — webhook signing', () => {
  const body = Buffer.from(
    JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } }),
  );

  it('accepts a Stripe-scheme signature and normalizes the event', () => {
    const h = harness();
    const t = Math.floor(h.clock.now.getTime() / 1000);
    const event = h.provider.constructWebhookEvent(body, signSimulatedPayload(body, SECRET, t), SECRET);
    expect(event).toMatchObject({ id: 'evt_x', type: 'payment_intent.succeeded', paymentIntentId: 'pi_1' });
  });

  it('rejects a wrong secret, a tampered body, a stale timestamp and garbage', () => {
    const h = harness();
    const t = Math.floor(h.clock.now.getTime() / 1000);
    const sig = signSimulatedPayload(body, SECRET, t);
    expect(() => h.provider.constructWebhookEvent(body, signSimulatedPayload(body, 'other_secret_value', t), SECRET)).toThrow();
    expect(() => h.provider.constructWebhookEvent(Buffer.from(`${body.toString()} `), sig, SECRET)).toThrow();
    expect(() =>
      h.provider.constructWebhookEvent(body, signSimulatedPayload(body, SECRET, t - 301), SECRET),
    ).toThrow(/tolerance/);
    expect(() => h.provider.constructWebhookEvent(body, 'nonsense', SECRET)).toThrow();
  });

  it('a failed delivery stays in the outbox and is retried in order', async () => {
    const h = harness();
    const customerId = await customerWithCard(h, CARD.ok);
    h.delivered.length = 0;
    h.failDeliveries.on = true;
    const pi = await charge(h, customerId);
    await h.runTimers();
    expect(h.delivered).toHaveLength(0);
    h.failDeliveries.on = false;
    expect(await h.provider.deliverPendingEvents()).toBe(1);
    expect(h.delivered.map((e) => e.paymentIntentId)).toEqual([pi.id]);
    expect(await h.provider.deliverPendingEvents()).toBe(0);
  });

  it('generates a random per-process secret when none is configured', () => {
    const a = createSimulatedPaymentProvider({
      store: createInMemorySimulatedPaymentStore(),
      deliveryDelayMs: 0,
    });
    const b = createSimulatedPaymentProvider({
      store: createInMemorySimulatedPaymentStore(),
      deliveryDelayMs: 0,
    });
    expect(a.webhookSecret).toMatch(new RegExp('^whsec_' + 'sim_[0-9a-f]{48}$'));
    expect(a.webhookSecret).not.toBe(b.webhookSecret);
  });
});
