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
import type { PaymentProviderName } from '@feasly/contracts';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import { tenants } from '../../db/schema';
import { HttpError, ErrorCodes } from '../../middleware/errors';
import {
  normalizeStripeEvent,
  type CardSummary,
  type CustomerDetails,
  type NormalizedStripeEvent,
  type OffSessionChargeInput,
  type OffSessionChargeResult,
  type PaymentIntentConfirmation,
  type PaymentIntentStatus,
  type PaymentProvider,
} from './payment-provider';

export type {
  CardSummary,
  CustomerDetails,
  NormalizedStripeEvent,
  OffSessionChargeInput,
  OffSessionChargeResult,
  PaymentIntentConfirmation,
  PaymentIntentStatus,
  PaymentProvider,
} from './payment-provider';

/**
 * The Stripe operations billing needs — now the provider-neutral
 * `PaymentProvider` (#753). Kept as an alias so existing imports and test
 * fakes keep compiling.
 */
export type StripeClient = PaymentProvider;

export interface StripeService {
  /** False when no STRIPE_SECRET_KEY is configured (billing dormant). */
  readonly isConfigured: boolean;
  /**
   * True when no real money can move: an `sk_test_…` key, or the simulated
   * provider (#753).
   */
  readonly testMode: boolean;
  /** #753: which provider is live (absent on legacy test fakes = stripe). */
  readonly provider?: PaymentProviderName;
  createCustomer(
    input: CustomerDetails,
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  /** #716: sync the customer's business name/email/builder metadata. */
  updateCustomer(customerId: string, input: CustomerDetails): Promise<void>;
  createSetupIntent(customerId: string): Promise<{
    id: string;
    clientSecret: string;
  }>;
  /**
   * Saved card payment methods for a customer, newest first. Display-safe
   * summaries only — never the PAN.
   */
  listPaymentMethods(customerId: string): Promise<readonly CardSummary[]>;
  /** #716: the customer's default payment method id, or null. */
  getDefaultPaymentMethodId(customerId: string): Promise<string | null>;
  /** #716: make a saved card the customer's default payment method. */
  setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void>;
  /** #716: detach (remove) a saved card from its customer. */
  detachPaymentMethod(paymentMethodId: string): Promise<{ id: string }>;
  /**
   * Charge the customer's default card off-session. The configured
   * statement descriptor (#716) is added here — callers never pass it.
   */
  createOffSessionPaymentIntent(
    input: Omit<OffSessionChargeInput, 'statementDescriptorSuffix'>,
    idempotencyKey: string,
  ): Promise<OffSessionChargeResult>;
  /**
   * #712: client secret + card for an on-session 3DS confirmation.
   * Read-only — never confirms.
   */
  getPaymentIntentConfirmation(
    paymentIntentId: string,
  ): Promise<PaymentIntentConfirmation>;
  createSubscription(input: {
    customerId: string;
    priceId: string;
  }): Promise<{ id: string; status: string }>;
  cancelSubscription(subscriptionId: string): Promise<{ id: string }>;
  /**
   * Refund a PaymentIntent in full (dispute console: credit note when an
   * accepted dispute's invoice was already paid). Idempotent via the
   * idempotency key — timer/retry safe.
   */
  refundPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
    /** Partial refund amount in cents; omit for a full refund. */
    amountCents?: number,
  ): Promise<{ id: string; status: string }>;
  /**
   * Read a PaymentIntent's current status (#711 reconciliation). Read-only —
   * never confirms, captures, or cancels.
   */
  retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentStatus>;
  /**
   * Verify the webhook signature and normalize the event. Throws
   * INVALID_SIGNATURE (401) on a bad signature — never a 500.
   */
  verifyWebhook(rawBody: Buffer, signature: string): NormalizedStripeEvent;
  /** Persist the Stripe customer id on the tenant row. */
  /** Throws when no tenants row matches — never a silent no-op (#710). */
  saveCustomerId(tenantKey: string, customerId: string): Promise<void>;
  getCustomerId(tenantKey: string): Promise<string | null>;
  /** Reverse lookup: which tenant owns this Stripe customer id. */
  getTenantKeyByCustomerId(customerId: string): Promise<string | null>;
  /**
   * #716 `customer.deleted`: forget a Stripe customer id on whichever tenant
   * holds it, so the next card setup creates a fresh customer. Returns the
   * tenant key that was cleared, or null when no tenant held it.
   */
  clearCustomerId(customerId: string): Promise<string | null>;
}

export interface StripeServiceDeps {
  readonly db: AppDb;
  readonly billing: BillingConfig;
  /**
   * The payment provider. Defaults to the Stripe SDK client when a secret
   * key is configured; composition passes the simulated provider when
   * `PAYMENTS_PROVIDER=simulated` (#753); tests inject a fake.
   */
  readonly client?: StripeClient | null;
  /**
   * Webhook signing secret override — the simulated provider's dev secret
   * (#753). Defaults to `billing.stripeWebhookSecret`.
   */
  readonly webhookSecret?: string;
}

/**
 * The PaymentIntent a rejected off-session confirm created, read from the
 * StripeCardError (`error.payment_intent`), with the card-error details
 * (#712): `code` (`card_declined`, `authentication_required`, …),
 * `decline_code` and the display-safe `message`. Null for any other error —
 * network / 5xx / rate-limit errors keep throwing so the invoice stays in
 * review for the next cycle.
 */
export function declinedPaymentIntent(
  error: unknown,
): OffSessionChargeResult | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as {
    type?: unknown;
    payment_intent?: unknown;
    code?: unknown;
    decline_code?: unknown;
    message?: unknown;
  };
  if (e.type !== 'StripeCardError') return null;
  const pi = e.payment_intent as { id?: unknown; status?: unknown } | undefined;
  if (!pi || typeof pi.id !== 'string' || typeof pi.status !== 'string') {
    return null;
  }
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const errorCode = text(e.code);
  const declineCode = text(e.decline_code);
  const failureMessage = text(e.message);
  return {
    id: pi.id,
    status: pi.status,
    ...(errorCode ? { errorCode } : {}),
    ...(declineCode ? { declineCode } : {}),
    ...(failureMessage ? { failureMessage } : {}),
  };
}

/** Customer metadata Feasly owns (#716 adds the builder id). */
function customerMetadata(input: CustomerDetails): Record<string, string> {
  return {
    feasly_tenant_key: input.tenantKey,
    ...(input.builderId ? { feasly_builder_id: input.builderId } : {}),
  };
}

/**
 * The production `PaymentProvider` (StripePaymentProvider) — thin wrapper
 * over the official Stripe SDK.
 */
export function createStripeSdkClient(secretKey: string): StripeClient {
  const stripe = new Stripe(secretKey);
  async function defaultPaymentMethodId(
    customerId: string,
  ): Promise<string | null> {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    const pm = customer.invoice_settings?.default_payment_method;
    if (!pm) return null;
    return typeof pm === 'string' ? pm : pm.id;
  }
  return {
    name: 'stripe',
    async createCustomer(input, idempotencyKey) {
      const customer = await stripe.customers.create(
        {
          email: input.email,
          ...(input.name ? { name: input.name } : {}),
          metadata: customerMetadata(input),
        },
        { idempotencyKey },
      );
      return { id: customer.id };
    },
    async updateCustomer(customerId, input) {
      await stripe.customers.update(customerId, {
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        metadata: customerMetadata(input),
      });
    },
    async createSetupIntent(customerId) {
      const intent = await stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        // stripe-node v23 removed `payment_method_types`; automatic payment
        // methods with redirects disallowed preserves card-only off_session
        // behavior (redirect methods can't be used off-session anyway).
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      });
      return { id: intent.id, clientSecret: intent.client_secret ?? '' };
    },
    async listPaymentMethods(customerId) {
      const methods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      });
      return methods.data.map((pm) => ({
        id: pm.id,
        brand: pm.card?.brand ?? 'unknown',
        last4: pm.card?.last4 ?? '****',
        expMonth: pm.card?.exp_month ?? 0,
        expYear: pm.card?.exp_year ?? 0,
      }));
    },
    getDefaultPaymentMethodId: defaultPaymentMethodId,
    async setDefaultPaymentMethod(customerId, paymentMethodId) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    },
    async detachPaymentMethod(paymentMethodId) {
      const pm = await stripe.paymentMethods.detach(paymentMethodId);
      return { id: pm.id };
    },
    async createOffSessionPaymentIntent(input, idempotencyKey) {
      // Resolve an explicit payment method (#716): the customer's default
      // card — the one the builder chose. Charging with only `customer`
      // fails when no default is set, so fall back to the newest saved card
      // (a card saved before the default was set by the setup webhook).
      const defaultPm = await defaultPaymentMethodId(input.customerId);
      const methods = defaultPm
        ? null
        : await stripe.paymentMethods.list({
            customer: input.customerId,
            type: 'card',
            limit: 1,
          });
      const pm = defaultPm ? { id: defaultPm } : methods?.data[0];
      if (!pm) {
        throw new HttpError(
          422,
          ErrorCodes.BILLING_NOT_CONFIGURED,
          `Tenant customer "${input.customerId}" has no card on file — cannot charge`,
        );
      }
      try {
        const intent = await stripe.paymentIntents.create(
          {
            amount: input.amountCents,
            currency: input.currency.toLowerCase(),
            customer: input.customerId,
            payment_method: pm.id,
            description: input.description,
            ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
            ...(input.statementDescriptorSuffix
              ? { statement_descriptor_suffix: input.statementDescriptorSuffix }
              : {}),
            off_session: true,
            confirm: true,
          },
          { idempotencyKey },
        );
        return { id: intent.id, status: intent.status };
      } catch (error) {
        // #753 provider contract: a declined confirm (StripeCardError) still
        // created a PaymentIntent. Return it with its status so the invoice
        // records the id and the payment_intent.payment_failed webhook can
        // settle it — throwing here left the invoice in review with no PI.
        const declined = declinedPaymentIntent(error);
        if (declined) return declined;
        throw error;
      }
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
    async refundPaymentIntent(paymentIntentId, idempotencyKey, amountCents) {
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          ...(amountCents !== undefined ? { amount: amountCents } : {}),
        },
        { idempotencyKey },
      );
      return { id: refund.id, status: refund.status ?? 'unknown' };
    },
    async retrievePaymentIntent(paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const message = intent.last_payment_error?.message;
      const code = intent.last_payment_error?.code;
      return {
        id: intent.id,
        status: intent.status,
        ...(typeof message === 'string' && message.length > 0
          ? { lastPaymentErrorMessage: message }
          : {}),
        ...(typeof code === 'string' && code.length > 0
          ? { lastPaymentErrorCode: code }
          : {}),
      };
    },
    async getPaymentIntentConfirmation(paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      // After an off-session `authentication_required` rejection Stripe
      // detaches the card from the intent; it survives on the last error.
      const pmRef =
        intent.payment_method ?? intent.last_payment_error?.payment_method ?? null;
      const paymentMethodId =
        typeof pmRef === 'string' ? pmRef : (pmRef?.id ?? undefined);
      return {
        id: intent.id,
        status: intent.status,
        clientSecret: intent.client_secret ?? '',
        ...(paymentMethodId ? { paymentMethodId } : {}),
      };
    },
    constructWebhookEvent(rawBody, signature, webhookSecret) {
      const event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
      return normalizeStripeEvent(event as unknown as Parameters<typeof normalizeStripeEvent>[0]);
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
    testMode:
      client?.name === 'simulated' ||
      (billing.stripeSecretKey ?? '').startsWith('sk_test_'),
    ...(client ? { provider: client.name } : {}),

    createCustomer: (input, idempotencyKey) =>
      requireClient().createCustomer(input, idempotencyKey),
    updateCustomer: (customerId, input) =>
      requireClient().updateCustomer(customerId, input),
    createSetupIntent: (customerId) =>
      requireClient().createSetupIntent(customerId),
    listPaymentMethods: (customerId) =>
      requireClient().listPaymentMethods(customerId),
    getDefaultPaymentMethodId: (customerId) =>
      requireClient().getDefaultPaymentMethodId(customerId),
    setDefaultPaymentMethod: (customerId, paymentMethodId) =>
      requireClient().setDefaultPaymentMethod(customerId, paymentMethodId),
    detachPaymentMethod: (paymentMethodId) =>
      requireClient().detachPaymentMethod(paymentMethodId),
    createOffSessionPaymentIntent: (input, idempotencyKey) =>
      requireClient().createOffSessionPaymentIntent(
        {
          ...input,
          ...(billing.statementDescriptor
            ? { statementDescriptorSuffix: billing.statementDescriptor }
            : {}),
        },
        idempotencyKey,
      ),
    createSubscription: (input) =>
      requireClient().createSubscription(input),
    cancelSubscription: (subscriptionId) =>
      requireClient().cancelSubscription(subscriptionId),
    refundPaymentIntent: (paymentIntentId, idempotencyKey, amountCents) =>
      requireClient().refundPaymentIntent(
        paymentIntentId,
        idempotencyKey,
        amountCents,
      ),
    retrievePaymentIntent: (paymentIntentId) =>
      requireClient().retrievePaymentIntent(paymentIntentId),
    getPaymentIntentConfirmation: (paymentIntentId) =>
      requireClient().getPaymentIntentConfirmation(paymentIntentId),

    verifyWebhook(rawBody: Buffer, signature: string): NormalizedStripeEvent {
      const webhookSecret = deps.webhookSecret ?? billing.stripeWebhookSecret;
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
      // Fail loudly (#710): an UPDATE matching zero rows used to report
      // success, so a Stripe customer was created on every card-setup
      // attempt but never remembered.
      const updated = await db
        .update(tenants)
        .set({ stripeCustomerId: customerId })
        .where(eq(tenants.tenantKey, tenantKey))
        .returning({ tenantKey: tenants.tenantKey });
      if (updated.length === 0) {
        throw new Error(
          `saveCustomerId: no tenants row for tenant "${tenantKey}" — Stripe customer ${customerId} was not persisted`,
        );
      }
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

    async clearCustomerId(customerId: string): Promise<string | null> {
      const cleared = await db
        .update(tenants)
        .set({ stripeCustomerId: null })
        .where(eq(tenants.stripeCustomerId, customerId))
        .returning({ tenantKey: tenants.tenantKey });
      return cleared[0]?.tenantKey ?? null;
    },
  };
}
