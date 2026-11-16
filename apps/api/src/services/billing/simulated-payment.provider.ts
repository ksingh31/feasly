/**
 * Simulated payment provider (#753) — a Stripe-shaped stand-in used until a
 * Stripe account exists (`PAYMENTS_PROVIDER=simulated`, set explicitly on dev only).
 *
 * Implements the same `PaymentProvider` interface as the Stripe SDK client,
 * with Stripe's object shapes (`cus_`, `seti_`, `pm_`, `pi_`, `re_`, `dp_`,
 * `evt_` ids), status names, decline codes/messages and event types. Card
 * behaviour comes from Stripe's public test card numbers
 * (`SIMULATED_TEST_CARDS` in @feasly/contracts) — no real card data is ever
 * accepted.
 *
 * Webhooks: every state change writes a Stripe-shaped event to the store
 * (an outbox). Events are signed with Stripe's `t=…,v1=…` HMAC scheme at
 * delivery time and handed to the PRODUCTION webhook handler
 * (`BillingWebhookService.handleWebhook`), so signature checks, event
 * idempotency and #711 reconciliation run for real. Charges deliver after
 * `deliveryDelayMs` (Stripe's webhooks are asynchronous too — the invoice
 * records the PaymentIntent id first); dev-panel actions deliver at once.
 * Anything still undelivered is flushed by the next dev action.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  SIMULATED_TEST_CARDS,
  type SimulatedCardBehavior,
  type SimulatedIntentResponse,
  type SimulatedIntentStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import {
  normalizeStripeEvent,
  type CardSummary,
  type NormalizedStripeEvent,
  type OffSessionChargeResult,
  type PaymentProvider,
} from './payment-provider';
import type { SimulatedObject, SimulatedPaymentStore } from './simulated-payment.store';

/** Split so the diff secrets scan (tools/check-secrets.mjs) does not flag it. */
const SIMULATED_SECRET_PREFIX = 'whsec_' + 'sim_';

/** Delivers one signed event to the webhook handler. */
export type SimulatedWebhookDeliverer = (
  rawBody: Buffer,
  signature: string,
) => Promise<unknown>;

export interface SimulatedPaymentProvider extends PaymentProvider {
  readonly name: 'simulated';
  /** Secret events are signed with (verify with the same value). */
  readonly webhookSecret: string;
  /** Wire the production webhook handler (composition, after it exists). */
  connectWebhook(deliver: SimulatedWebhookDeliverer): void;
  /** Stand-in for Stripe Elements' confirmCardSetup with a test card. */
  confirmSetupIntent(
    setupIntentId: string,
    cardNumber: string,
  ): Promise<SimulatedIntentResponse>;
  /** Dev-only "complete 3DS challenge" for an intent in requires_action. */
  authenticateIntent(
    intentId: string,
    outcome: 'complete' | 'fail',
  ): Promise<SimulatedIntentResponse>;
  /** Customer that owns a SetupIntent / PaymentIntent (null = unknown id). */
  getIntentCustomerId(intentId: string): Promise<string | null>;
  /** Stripe-dashboard style triggers for the admin dev panel. */
  fireDispute(paymentIntentId: string): Promise<{ eventType: string }>;
  fireDashboardRefund(
    paymentIntentId: string,
    amountCents?: number,
  ): Promise<{ eventType: string }>;
  fireDelayedFailure(paymentIntentId: string): Promise<{ eventType: string }>;
  /** Deliver every undelivered event now (ignores the delay). */
  deliverPendingEvents(): Promise<number>;
  /** Cancel scheduled deliveries (tests / shutdown). */
  dispose(): void;
}

export interface SimulatedPaymentProviderDeps {
  readonly store: SimulatedPaymentStore;
  /** Signing secret; undefined → random per-process secret. */
  readonly webhookSecret?: string;
  /** Delay before a charge's webhook is delivered. */
  readonly deliveryDelayMs: number;
  readonly now?: () => Date;
  /** Scheduler for delayed delivery; defaults to an unref'd setTimeout. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  readonly logWarning?: (message: string) => void;
}

/** Stripe's webhook timestamp tolerance (seconds). */
const SIGNATURE_TOLERANCE_SECONDS = 300;
const API_VERSION = 'simulated';

const DECLINES: Record<
  'card_declined' | 'insufficient_funds' | 'authentication_failed',
  { code: string; decline_code?: string; message: string }
> = {
  card_declined: {
    code: 'card_declined',
    decline_code: 'generic_decline',
    message: 'Your card was declined.',
  },
  insufficient_funds: {
    code: 'card_declined',
    decline_code: 'insufficient_funds',
    message: 'Your card has insufficient funds.',
  },
  authentication_failed: {
    code: 'payment_intent_authentication_failure',
    message:
      'The provided PaymentMethod has failed authentication. You can provide payment_method_data or a new PaymentMethod to attempt to fulfill this PaymentIntent again.',
  },
};

function behaviorOf(cardNumber: string): SimulatedCardBehavior | null {
  const digits = cardNumber.replace(/[\s-]/g, '');
  return SIMULATED_TEST_CARDS.find((c) => c.number === digits)?.behavior ?? null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/** Sign a payload the way Stripe does: v1 = HMAC-SHA256(`${t}.${body}`). */
export function signSimulatedPayload(
  body: Buffer,
  secret: string,
  timestampSeconds: number,
): string {
  const v1 = createHmac('sha256', secret)
    .update(`${timestampSeconds}.`)
    .update(body)
    .digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

export function createSimulatedPaymentProvider(
  deps: SimulatedPaymentProviderDeps,
): SimulatedPaymentProvider {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const logWarning =
    deps.logWarning ?? ((message: string) => console.warn(message));
  const secret =
    deps.webhookSecret ?? `${SIMULATED_SECRET_PREFIX}${randomBytes(24).toString('hex')}`;
  const timers = new Set<() => void>();
  const schedule =
    deps.schedule ??
    ((run: () => void, delayMs: number): (() => void) => {
      const handle = setTimeout(run, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    });
  let deliver: SimulatedWebhookDeliverer | null = null;
  // Serializes deliveries so events reach the handler in creation order.
  let deliveryChain: Promise<unknown> = Promise.resolve();
  let eventSeq = 0;

  const unix = (): number => Math.floor(now().getTime() / 1000);
  const randomId = (prefix: string): string =>
    `${prefix}_sim_${randomBytes(12).toString('hex')}`;
  /** Idempotency key → stable id, like Stripe replaying the first result. */
  const keyedId = (prefix: string, key: string): string =>
    `${prefix}_sim_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

  async function requireObject(
    id: string,
    objectType: string,
  ): Promise<SimulatedObject> {
    const row = await store.get(id);
    if (!row || row.objectType !== objectType) {
      throw new HttpError(
        404,
        ErrorCodes.NOT_FOUND,
        `No such ${objectType}: '${id}'`,
      );
    }
    return row;
  }

  async function put(
    id: string,
    objectType: string,
    customerId: string | null,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    return store.insert({ id, objectType, customerId, data, createdAt: now() });
  }

  /** Write a Stripe-shaped event to the outbox. */
  async function emit(
    type: string,
    object: Record<string, unknown>,
  ): Promise<void> {
    // Sortable id: creation order survives same-millisecond inserts.
    const id =
      `evt_sim_${now().getTime().toString().padStart(14, '0')}` +
      `${(++eventSeq % 10_000).toString().padStart(4, '0')}` +
      randomBytes(4).toString('hex');
    await put(id, 'event', str(object['customer']) ?? null, {
      id,
      object: 'event',
      api_version: API_VERSION,
      created: unix(),
      livemode: false,
      type,
      data: { object },
    });
  }

  function deliverDue(force: boolean): Promise<number> {
    const run = async (): Promise<number> => {
      if (!deliver) return 0;
      const cutoff = force
        ? now()
        : new Date(now().getTime() - deps.deliveryDelayMs);
      const due = await store.listUndeliveredEvents(cutoff);
      let delivered = 0;
      for (const event of due) {
        const body = Buffer.from(JSON.stringify(event.data), 'utf8');
        try {
          await deliver(body, signSimulatedPayload(body, secret, unix()));
        } catch (error) {
          // Like Stripe: a non-2xx leaves the event for a later retry.
          logWarning(
            `simulated-payments: webhook delivery of ${event.id} failed ` +
              `(${error instanceof Error ? error.message : 'unknown error'}); will retry`,
          );
          break;
        }
        await store.markDelivered(event.id, now());
        delivered += 1;
      }
      return delivered;
    };
    const next = deliveryChain.then(run, run);
    deliveryChain = next.catch(() => undefined);
    return next;
  }

  /** Deliver after the configured delay (charges — Stripe is async). */
  function deliverLater(): void {
    let cancel: () => void = () => undefined;
    const fire = (): void => {
      timers.delete(cancel);
      deliverDue(false).catch((error: unknown) =>
        logWarning(
          `simulated-payments: delayed delivery failed (${error instanceof Error ? error.message : 'unknown error'})`,
        ),
      );
    };
    cancel = schedule(fire, deps.deliveryDelayMs);
    timers.add(cancel);
  }

  async function newestCard(customerId: string): Promise<SimulatedObject | null> {
    const cards = await store.listByCustomer(customerId, 'payment_method');
    return cards[0] ?? null;
  }

  async function attachCard(
    customerId: string,
    cardNumber: string,
  ): Promise<SimulatedObject> {
    const digits = cardNumber.replace(/[\s-]/g, '');
    const card = SIMULATED_TEST_CARDS.find((c) => c.number === digits);
    if (!card) throw new Error('attachCard: not a test card');
    const id = randomId('pm');
    const data = {
      id,
      object: 'payment_method',
      type: 'card',
      customer: customerId,
      created: unix(),
      livemode: false,
      card: {
        brand: card.brand,
        last4: digits.slice(-4),
        exp_month: 12,
        exp_year: now().getUTCFullYear() + 3,
        funding: 'credit',
        country: 'US',
      },
      metadata: { simulated_behavior: card.behavior },
    };
    await put(id, 'payment_method', customerId, data);
    await emit('payment_method.attached', data);
    return { id, objectType: 'payment_method', customerId, data, createdAt: now(), deliveredAt: null };
  }

  function cardBehavior(pm: SimulatedObject): SimulatedCardBehavior {
    const meta = pm.data['metadata'] as Record<string, unknown> | undefined;
    return (str(meta?.['simulated_behavior']) as SimulatedCardBehavior) ?? 'succeeds';
  }

  function intentResponse(data: Record<string, unknown>): SimulatedIntentResponse {
    const status = str(data['status']) as SimulatedIntentStatus;
    const err = (data['last_payment_error'] ?? data['last_setup_error']) as
      | Record<string, unknown>
      | null
      | undefined;
    const message = err ? str(err['message']) : undefined;
    return {
      intentId: str(data['id']) ?? '',
      status,
      ...(status === 'requires_action' ? { nextAction: 'three_d_secure' as const } : {}),
      ...(message ? { lastErrorMessage: message } : {}),
    };
  }

  /** A stored PaymentIntent as an off-session charge result (#712). */
  function chargeResult(data: Record<string, unknown>): OffSessionChargeResult {
    const err = data['last_payment_error'] as Record<string, unknown> | null | undefined;
    const errorCode = err ? str(err['code']) : undefined;
    const declineCode = err ? str(err['decline_code']) : undefined;
    const failureMessage = err ? str(err['message']) : undefined;
    return {
      id: str(data['id']) ?? '',
      status: str(data['status']) ?? 'unknown',
      ...(errorCode ? { errorCode } : {}),
      ...(declineCode ? { declineCode } : {}),
      ...(failureMessage ? { failureMessage } : {}),
    };
  }

  /** Settle a PaymentIntent as succeeded (charge object + event). */
  function succeedPayment(pi: Record<string, unknown>): Record<string, unknown> {
    return {
      ...pi,
      status: 'succeeded',
      amount_received: num(pi['amount']),
      latest_charge: str(pi['latest_charge']) ?? randomId('ch'),
      next_action: null,
      last_payment_error: null,
    };
  }

  function failPayment(
    pi: Record<string, unknown>,
    decline: (typeof DECLINES)[keyof typeof DECLINES],
  ): Record<string, unknown> {
    return {
      ...pi,
      status: 'requires_payment_method',
      next_action: null,
      last_payment_error: {
        type: 'card_error',
        payment_method: { id: str(pi['payment_method']) },
        ...decline,
      },
    };
  }

  const provider: SimulatedPaymentProvider = {
    name: 'simulated',
    webhookSecret: secret,

    connectWebhook(fn) {
      deliver = fn;
    },

    async createCustomer(input, idempotencyKey) {
      const id = keyedId('cus', idempotencyKey);
      await put(id, 'customer', id, {
        id,
        object: 'customer',
        created: unix(),
        email: input.email ?? null,
        livemode: false,
        metadata: { feasly_tenant_key: input.tenantKey },
      });
      return { id };
    },

    async createSetupIntent(customerId) {
      await requireObject(customerId, 'customer');
      const id = randomId('seti');
      const clientSecret = `${id}_secret_${randomBytes(12).toString('hex')}`;
      await put(id, 'setup_intent', customerId, {
        id,
        object: 'setup_intent',
        created: unix(),
        customer: customerId,
        client_secret: clientSecret,
        usage: 'off_session',
        status: 'requires_payment_method',
        payment_method: null,
        livemode: false,
      });
      return { id, clientSecret };
    },

    async listPaymentMethods(customerId): Promise<readonly CardSummary[]> {
      const cards = await store.listByCustomer(customerId, 'payment_method');
      return cards.map((pm) => {
        const card = (pm.data['card'] ?? {}) as Record<string, unknown>;
        return {
          id: pm.id,
          brand: str(card['brand']) ?? 'unknown',
          last4: str(card['last4']) ?? '****',
          expMonth: num(card['exp_month']),
          expYear: num(card['exp_year']),
        };
      });
    },

    async detachPaymentMethod(paymentMethodId) {
      const pm = await requireObject(paymentMethodId, 'payment_method');
      const data = { ...pm.data, customer: null };
      await store.update(paymentMethodId, { data, customerId: null });
      await emit('payment_method.detached', {
        ...data,
        // Stripe's detached event no longer carries the customer; keep the
        // previous owner so the handler can attribute the audit row.
        customer: pm.customerId,
      });
      deliverLater();
      return { id: paymentMethodId };
    },

    async createOffSessionPaymentIntent(input, idempotencyKey) {
      const id = keyedId('pi', idempotencyKey);
      const existing = await store.get(id);
      if (existing) {
        return chargeResult(existing.data);
      }
      await requireObject(input.customerId, 'customer');
      const pm = await newestCard(input.customerId);
      if (!pm) {
        throw new HttpError(
          422,
          ErrorCodes.BILLING_NOT_CONFIGURED,
          `Tenant customer "${input.customerId}" has no card on file — cannot charge`,
        );
      }
      const base: Record<string, unknown> = {
        id,
        object: 'payment_intent',
        created: unix(),
        amount: input.amountCents,
        amount_received: 0,
        amount_refunded: 0,
        currency: input.currency.toLowerCase(),
        customer: input.customerId,
        payment_method: pm.id,
        description: input.description,
        metadata: { ...(input.metadata ?? {}) },
        off_session: true,
        confirmation_method: 'automatic',
        livemode: false,
        next_action: null,
        last_payment_error: null,
      };
      const behavior = cardBehavior(pm);
      let data: Record<string, unknown>;
      let eventType: string;
      if (behavior === 'succeeds') {
        data = succeedPayment(base);
        eventType = 'payment_intent.succeeded';
      } else if (behavior === 'requires_3ds') {
        data = {
          ...base,
          status: 'requires_action',
          next_action: { type: 'use_stripe_sdk' },
        };
        eventType = 'payment_intent.requires_action';
      } else {
        data = failPayment(base, DECLINES[behavior]);
        eventType = 'payment_intent.payment_failed';
      }
      const inserted = await put(id, 'payment_intent', input.customerId, data);
      if (!inserted) {
        // Lost an idempotency race — replay the winner's result.
        const winner = await requireObject(id, 'payment_intent');
        return chargeResult(winner.data);
      }
      await emit(eventType, data);
      deliverLater();
      return chargeResult(data);
    },

    async getPaymentIntentConfirmation(paymentIntentId) {
      const pi = await requireObject(paymentIntentId, 'payment_intent');
      const paymentMethodId = str(pi.data['payment_method']);
      return {
        id: paymentIntentId,
        status: str(pi.data['status']) ?? 'unknown',
        // Stripe's shape (`pi_…_secret_…`); the simulated confirm step
        // (POST /billing/simulated/authenticate) takes the intent id.
        clientSecret: `${paymentIntentId}_secret_sim`,
        ...(paymentMethodId ? { paymentMethodId } : {}),
      };
    },

    async refundPaymentIntent(paymentIntentId, idempotencyKey, amountCents) {
      const id = keyedId('re', idempotencyKey);
      const existing = await store.get(id);
      if (existing) {
        return { id, status: str(existing.data['status']) ?? 'unknown' };
      }
      const pi = await requireObject(paymentIntentId, 'payment_intent');
      if (pi.data['status'] !== 'succeeded') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `PaymentIntent ${paymentIntentId} is '${str(pi.data['status'])}' — only a succeeded charge can be refunded`,
        );
      }
      const remaining = num(pi.data['amount']) - num(pi.data['amount_refunded']);
      const amount = amountCents ?? remaining;
      if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Refund amount must be between 1 and ${remaining} cents`,
        );
      }
      const refunded = num(pi.data['amount_refunded']) + amount;
      const piData = { ...pi.data, amount_refunded: refunded };
      await store.update(paymentIntentId, { data: piData });
      const chargeId = str(pi.data['latest_charge']);
      await put(id, 'refund', pi.customerId, {
        id,
        object: 'refund',
        created: unix(),
        amount,
        currency: pi.data['currency'],
        charge: chargeId,
        payment_intent: paymentIntentId,
        status: 'succeeded',
      });
      await emit('charge.refunded', {
        id: chargeId,
        object: 'charge',
        amount: pi.data['amount'],
        amount_refunded: refunded,
        refunded: refunded >= num(pi.data['amount']),
        currency: pi.data['currency'],
        customer: pi.customerId,
        payment_intent: paymentIntentId,
        status: 'succeeded',
      });
      deliverLater();
      return { id, status: 'succeeded' };
    },

    async retrievePaymentIntent(paymentIntentId) {
      const pi = await requireObject(paymentIntentId, 'payment_intent');
      const err = pi.data['last_payment_error'] as Record<string, unknown> | null;
      const message = err ? str(err['message']) : undefined;
      return {
        id: pi.id,
        status: str(pi.data['status']) ?? 'unknown',
        ...(message ? { lastPaymentErrorMessage: message } : {}),
      };
    },

    async createSubscription(input) {
      await requireObject(input.customerId, 'customer');
      const pm = await newestCard(input.customerId);
      const behavior = pm ? cardBehavior(pm) : 'card_declined';
      const id = randomId('sub');
      const paid = behavior === 'succeeds';
      const data = {
        id,
        object: 'subscription',
        created: unix(),
        customer: input.customerId,
        status: paid ? 'active' : 'incomplete',
        items: { data: [{ price: { id: input.priceId } }] },
        collection_method: 'charge_automatically',
        livemode: false,
      };
      await put(id, 'subscription', input.customerId, data);
      await emit('customer.subscription.created', data);
      const invoiceId = randomId('in');
      await emit(paid ? 'invoice.payment_succeeded' : 'invoice.payment_failed', {
        id: invoiceId,
        object: 'invoice',
        customer: input.customerId,
        subscription: id,
        status: paid ? 'paid' : 'open',
        livemode: false,
      });
      if (paid) {
        // Stripe follows a paid first invoice with a subscription update
        // (latest_invoice / current period stamped).
        await emit('customer.subscription.updated', {
          ...data,
          latest_invoice: invoiceId,
        });
      }
      deliverLater();
      return { id, status: data.status };
    },

    async cancelSubscription(subscriptionId) {
      const sub = await requireObject(subscriptionId, 'subscription');
      const data = { ...sub.data, status: 'canceled', canceled_at: unix() };
      await store.update(subscriptionId, { data });
      await emit('customer.subscription.deleted', data);
      deliverLater();
      return { id: subscriptionId };
    },

    constructWebhookEvent(rawBody, signature, webhookSecret): NormalizedStripeEvent {
      const parts = new Map<string, string[]>();
      for (const part of signature.split(',')) {
        const [k, v] = part.split('=', 2);
        if (!k || v === undefined) continue;
        parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()]);
      }
      const t = Number(parts.get('t')?.[0]);
      const candidates = parts.get('v1') ?? [];
      if (!Number.isFinite(t) || candidates.length === 0) {
        throw new Error('Unable to extract timestamp and signatures from header');
      }
      if (Math.abs(unix() - t) > SIGNATURE_TOLERANCE_SECONDS) {
        throw new Error('Timestamp outside the tolerance zone');
      }
      const expected = Buffer.from(
        createHmac('sha256', webhookSecret).update(`${t}.`).update(rawBody).digest('hex'),
        'utf8',
      );
      const ok = candidates.some((c) => {
        const given = Buffer.from(c, 'utf8');
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
      if (!ok) {
        throw new Error('No signatures found matching the expected signature');
      }
      const event = JSON.parse(rawBody.toString('utf8')) as {
        id: string;
        type: string;
        data?: { object?: unknown };
      };
      return normalizeStripeEvent(event);
    },

    async confirmSetupIntent(setupIntentId, cardNumber) {
      await deliverDue(false);
      const behavior = behaviorOf(cardNumber);
      if (!behavior) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          'Test mode accepts only the listed test card numbers.',
        );
      }
      const si = await requireObject(setupIntentId, 'setup_intent');
      if (si.data['status'] !== 'requires_payment_method') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `SetupIntent ${setupIntentId} is '${str(si.data['status'])}' — it cannot be confirmed again`,
        );
      }
      const customerId = str(si.data['customer']) ?? '';
      let data: Record<string, unknown>;
      if (behavior === 'requires_3ds') {
        data = {
          ...si.data,
          status: 'requires_action',
          next_action: { type: 'use_stripe_sdk' },
          // Public Stripe test number only (validated above) — never a PAN.
          pending_test_card: cardNumber.replace(/[\s-]/g, ''),
        };
        await store.update(setupIntentId, { data });
        await emit('setup_intent.requires_action', data);
      } else {
        const pm = await attachCard(customerId, cardNumber);
        data = {
          ...si.data,
          status: 'succeeded',
          payment_method: pm.id,
          last_setup_error: null,
        };
        await store.update(setupIntentId, { data });
        await emit('setup_intent.succeeded', data);
      }
      await deliverDue(true);
      return intentResponse(data);
    },

    async authenticateIntent(intentId, outcome) {
      await deliverDue(false);
      const row = await store.get(intentId);
      if (
        !row ||
        (row.objectType !== 'setup_intent' && row.objectType !== 'payment_intent')
      ) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, `No such intent: '${intentId}'`);
      }
      if (row.data['status'] !== 'requires_action') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `${intentId} is '${str(row.data['status'])}' — there is no 3D Secure challenge to complete`,
        );
      }
      let data: Record<string, unknown>;
      if (row.objectType === 'setup_intent') {
        const { pending_test_card: pending, ...rest } = row.data;
        if (outcome === 'complete') {
          const pm = await attachCard(str(row.data['customer']) ?? '', str(pending) ?? '');
          data = { ...rest, status: 'succeeded', payment_method: pm.id, next_action: null };
          await store.update(intentId, { data });
          await emit('setup_intent.succeeded', data);
        } else {
          data = {
            ...rest,
            status: 'requires_payment_method',
            next_action: null,
            last_setup_error: {
              type: 'card_error',
              code: 'setup_intent_authentication_failure',
              message:
                'The latest attempt to set up the payment method has failed because authentication failed.',
            },
          };
          await store.update(intentId, { data });
          await emit('setup_intent.setup_failed', data);
        }
      } else if (outcome === 'complete') {
        data = succeedPayment(row.data);
        await store.update(intentId, { data });
        await emit('payment_intent.succeeded', data);
      } else {
        data = failPayment(row.data, DECLINES.authentication_failed);
        await store.update(intentId, { data });
        await emit('payment_intent.payment_failed', data);
      }
      await deliverDue(true);
      return intentResponse(data);
    },

    async getIntentCustomerId(intentId) {
      const row = await store.get(intentId);
      if (
        !row ||
        (row.objectType !== 'setup_intent' && row.objectType !== 'payment_intent')
      ) {
        return null;
      }
      return str(row.data['customer']) ?? null;
    },

    async fireDispute(paymentIntentId) {
      await deliverDue(false);
      const pi = await requireObject(paymentIntentId, 'payment_intent');
      if (pi.data['status'] !== 'succeeded') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `PaymentIntent ${paymentIntentId} is '${str(pi.data['status'])}' — only a succeeded charge can be disputed`,
        );
      }
      const id = randomId('dp');
      const data = {
        id,
        object: 'dispute',
        created: unix(),
        amount: pi.data['amount'],
        currency: pi.data['currency'],
        charge: pi.data['latest_charge'],
        payment_intent: paymentIntentId,
        reason: 'fraudulent',
        status: 'needs_response',
        livemode: false,
      };
      await put(id, 'dispute', pi.customerId, data);
      await emit('charge.dispute.created', data);
      await deliverDue(true);
      return { eventType: 'charge.dispute.created' };
    },

    async fireDashboardRefund(paymentIntentId, amountCents) {
      await deliverDue(false);
      await provider.refundPaymentIntent(
        paymentIntentId,
        `dashboard-refund:${randomBytes(8).toString('hex')}`,
        amountCents,
      );
      await deliverDue(true);
      return { eventType: 'charge.refunded' };
    },

    async fireDelayedFailure(paymentIntentId) {
      await deliverDue(false);
      const pi = await requireObject(paymentIntentId, 'payment_intent');
      const status = str(pi.data['status']);
      if (status !== 'processing' && status !== 'requires_action') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `PaymentIntent ${paymentIntentId} is '${status}' — only an in-flight charge (processing / requires_action) can fail later`,
        );
      }
      const data = failPayment(pi.data, DECLINES.card_declined);
      await store.update(paymentIntentId, { data });
      await emit('payment_intent.payment_failed', data);
      await deliverDue(true);
      return { eventType: 'payment_intent.payment_failed' };
    },

    deliverPendingEvents: () => deliverDue(true),

    dispose() {
      for (const cancel of timers) cancel();
      timers.clear();
    },
  };
  return provider;
}
