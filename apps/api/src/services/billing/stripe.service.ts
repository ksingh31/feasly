/**
 * Stripe service (billing/02).
 *
 * The ONLY module that touches the Stripe SDK. Everything else talks to
 * this interface, so billing logic is testable without the network and
 * Stripe is swappable without touching the commission/flat engines.
 *
 * Test-mode enforcement happens in config.ts (`enforceStripeTestMode`):
 * non-production requires `sk_test_…`, production requires `sk_live_…`.
 * When no secret key is configured the client is absent and every method
 * fails fast with BILLING_NOT_CONFIGURED — billing stays dormant.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import { tenants } from '../../db/schema';
import { HttpError, ErrorCodes } from '../../middleware/errors';

/** Normalized Stripe webhook event — the fields billing cares about. */
export interface NormalizedStripeEvent {
  readonly id: string;
  readonly type: string;
  readonly paymentIntentId?: string;
  readonly customerId?: string;
  readonly subscriptionId?: string;
  readonly invoiceId?: string;
  readonly paymentMethodId?: string;
}

/**
 * The Stripe operations billing needs. The real implementation wraps the
 * official SDK; tests inject a fake. Deliberately narrow — no direct SDK
 * types leak past this interface.
 */
export interface StripeClient {
  createCustomer(input: {
    tenantKey: string;
    email?: string;
  }): Promise<{ id: string }>;
  createSetupIntent(customerId: string): Promise<{
    id: string;
    clientSecret: string;
  }>;
  createOffSessionPaymentIntent(
    input: {
      amountCents: number;
      currency: string;
      customerId: string;
      description: string;
    },
    idempotencyKey: string,
  ): Promise<{ id: string; status: string }>;
  createSubscription(input: {
    customerId: string;
    priceId: string;
  }): Promise<{ id: string; status: string }>;
  cancelSubscription(subscriptionId: string): Promise<{ id: string }>;
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
    webhookSecret: string,
  ): NormalizedStripeEvent;
}

export interface StripeService {
  /** False when no STRIPE_SECRET_KEY is configured (billing dormant). */
  readonly isConfigured: boolean;
  /** True when the configured key is a test key (`sk_test_…`). */
  readonly testMode: boolean;
  createCustomer(input: {
    tenantKey: string;
    email?: string;
  }): Promise<{ id: string }>;
  createSetupIntent(customerId: string): Promise<{
    id: string;
    clientSecret: string;
  }>;
  createOffSessionPaymentIntent(
    input: {
      amountCents: number;
      currency: string;
      customerId: string;
      description: string;
    },
    idempotencyKey: string,
  ): Promise<{ id: string; status: string }>;
  createSubscription(input: {
    customerId: string;
    priceId: string;
  }): Promise<{ id: string; status: string }>;
  cancelSubscription(subscriptionId: string): Promise<{ id: string }>;
  /**
   * Verify the webhook signature and normalize the event. Throws
   * INVALID_SIGNATURE (401) on a bad signature — never a 500.
   */
  verifyWebhook(rawBody: Buffer, signature: string): NormalizedStripeEvent;
  /** Persist the Stripe customer id on the tenant row. */
  saveCustomerId(tenantKey: string, customerId: string): Promise<void>;
  getCustomerId(tenantKey: string): Promise<string | null>;
  /** Reverse lookup: which tenant owns this Stripe customer id. */
  getTenantKeyByCustomerId(customerId: string): Promise<string | null>;
}

export interface StripeServiceDeps {
  readonly db: AppDb;
  readonly billing: BillingConfig;
  /** Defaults to the real SDK client; tests inject a fake. */
  readonly client?: StripeClient | null;
}

function normalizeEvent(event: Stripe.Event): NormalizedStripeEvent {
  const data = (event.data?.object ?? {}) as unknown as Record<
    string,
    unknown
  >;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  return {
    id: event.id,
    type: event.type,
    paymentIntentId: event.type.startsWith('payment_intent.')
      ? str(data['id'])
      : undefined,
    customerId:
      str(data['customer']) ??
      (typeof data['customer'] === 'object' && data['customer'] !== null
        ? str((data['customer'] as Record<string, unknown>)['id'])
        : undefined),
    subscriptionId: event.type.startsWith('customer.subscription.')
      ? str(data['id'])
      : str(data['subscription']),
    invoiceId: event.type.startsWith('invoice.')
      ? str(data['id'])
      : undefined,
    paymentMethodId: event.type.startsWith('payment_method.')
      ? str(data['id'])
      : undefined,
  };
}

/** The production client — thin wrapper over the official Stripe SDK. */
export function createStripeSdkClient(secretKey: string): StripeClient {
  const stripe = new Stripe(secretKey);
  return {
    async createCustomer(input) {
      const customer = await stripe.customers.create({
        email: input.email,
        metadata: { feasly_tenant_key: input.tenantKey },
      });
      return { id: customer.id };
    },
    async createSetupIntent(customerId) {
      const intent = await stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        payment_method_types: ['card'],
      });
      return { id: intent.id, clientSecret: intent.client_secret ?? '' };
    },
    async createOffSessionPaymentIntent(input, idempotencyKey) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          customer: input.customerId,
          description: input.description,
          off_session: true,
          confirm: true,
        },
        { idempotencyKey },
      );
      return { id: intent.id, status: intent.status };
    },
    async createSubscription(input) {
      const subscription = await stripe.subscriptions.create({
        customer: input.customerId,
        items: [{ price: input.priceId }],
        collection_method: 'charge_automatically',
        proration_behavior: 'create_prorations',
      });
      return { id: subscription.id, status: subscription.status };
    },
    async cancelSubscription(subscriptionId) {
      const subscription = await stripe.subscriptions.cancel(subscriptionId);
      return { id: subscription.id };
    },
    constructWebhookEvent(rawBody, signature, webhookSecret) {
      const event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
      return normalizeEvent(event);
    },
  };
}

export function createStripeService(deps: StripeServiceDeps): StripeService {
  const { db, billing } = deps;
  const client: StripeClient | null =
    deps.client !== undefined
      ? deps.client
      : billing.stripeSecretKey
        ? createStripeSdkClient(billing.stripeSecretKey)
        : null;

  function requireClient(): StripeClient {
    if (!client) {
      throw new HttpError(
        503,
        ErrorCodes.BILLING_NOT_CONFIGURED,
        'Billing is not configured: STRIPE_SECRET_KEY is not set',
      );
    }
    return client;
  }

  return {
    isConfigured: client !== null,
    testMode: (billing.stripeSecretKey ?? '').startsWith('sk_test_'),

    createCustomer: (input) => requireClient().createCustomer(input),
    createSetupIntent: (customerId) =>
      requireClient().createSetupIntent(customerId),
    createOffSessionPaymentIntent: (input, idempotencyKey) =>
      requireClient().createOffSessionPaymentIntent(input, idempotencyKey),
    createSubscription: (input) =>
      requireClient().createSubscription(input),
    cancelSubscription: (subscriptionId) =>
      requireClient().cancelSubscription(subscriptionId),

    verifyWebhook(rawBody: Buffer, signature: string): NormalizedStripeEvent {
      const webhookSecret = billing.stripeWebhookSecret;
      if (!webhookSecret) {
        throw new HttpError(
          503,
          ErrorCodes.BILLING_NOT_CONFIGURED,
          'Billing is not configured: STRIPE_WEBHOOK_SECRET is not set',
        );
      }
      if (!signature) {
        throw new HttpError(
          401,
          ErrorCodes.INVALID_SIGNATURE,
          'Missing Stripe signature header',
        );
      }
      try {
        return requireClient().constructWebhookEvent(
          rawBody,
          signature,
          webhookSecret,
        );
      } catch {
        throw new HttpError(
          401,
          ErrorCodes.INVALID_SIGNATURE,
          'Stripe webhook signature verification failed',
        );
      }
    },

    async saveCustomerId(tenantKey: string, customerId: string): Promise<void> {
      await db
        .update(tenants)
        .set({ stripeCustomerId: customerId })
        .where(eq(tenants.tenantKey, tenantKey));
    },

    async getCustomerId(tenantKey: string): Promise<string | null> {
      const row = await db.query.tenants.findFirst({
        where: eq(tenants.tenantKey, tenantKey),
        columns: { stripeCustomerId: true },
      });
      return row?.stripeCustomerId ?? null;
    },

    async getTenantKeyByCustomerId(customerId: string): Promise<string | null> {
      const row = await db.query.tenants.findFirst({
        where: eq(tenants.stripeCustomerId, customerId),
        columns: { tenantKey: true },
      });
      return row?.tenantKey ?? null;
    },
  };
}
