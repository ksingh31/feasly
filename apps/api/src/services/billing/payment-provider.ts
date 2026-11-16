/**
 * Payment provider interface (#753).
 *
 * Everything billing asks of a payment processor, in Stripe's vocabulary
 * (customers, SetupIntents, payment methods, off-session PaymentIntents,
 * refunds, webhook events). Two implementations:
 *
 * - `createStripeSdkClient` (stripe.service.ts) — the official Stripe SDK.
 * - `createSimulatedPaymentProvider` (simulated-payment.provider.ts) — a
 *   Stripe-shaped simulation (same object shapes, status names, event types,
 *   test card numbers) used until a Stripe account exists. It signs its
 *   webhook events like Stripe and delivers them through the production
 *   webhook handler.
 *
 * `StripeService` wraps whichever provider config selects
 * (`PAYMENTS_PROVIDER = simulated | stripe`), so the commission/flat engines
 * never know which one is live. Deliberately narrow — no SDK types leak.
 *
 * Contract both providers honour: a declined off-session charge is a
 * PaymentIntent *status* (`requires_payment_method` + a
 * `payment_intent.payment_failed` webhook), never a thrown error — the
 * invoice must record the PaymentIntent id so the webhook can settle it.
 */
import type { PaymentProviderName } from '@feasly/contracts';

/**
 * Display-safe summary of a saved card payment method. Brand, last4 and
 * expiry only — the PAN never leaves the provider.
 */
export interface CardSummary {
  /** Provider payment method id (`pm_…`). */
  readonly id?: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
}

/**
 * A PaymentIntent's settlement-relevant state (#711 reconciliation).
 * `status` is Stripe's raw status string (`succeeded`, `processing`,
 * `requires_payment_method`, `requires_action`, `canceled`, …).
 */
export interface PaymentIntentStatus {
  readonly id: string;
  readonly status: string;
  /** `last_payment_error.message` when the provider recorded a decline. */
  readonly lastPaymentErrorMessage?: string;
}

/** Normalized webhook event — the fields billing cares about. */
export interface NormalizedStripeEvent {
  readonly id: string;
  readonly type: string;
  readonly paymentIntentId?: string;
  readonly customerId?: string;
  readonly subscriptionId?: string;
  readonly invoiceId?: string;
  readonly paymentMethodId?: string;
  /**
   * payment_intent.payment_failed: Stripe's `last_payment_error` message
   * (e.g. "Your card was declined."). BILL-03 surfaces it in the dunning
   * queue as the last failure reason. setup_intent.setup_failed (#716):
   * `last_setup_error.message`.
   */
  readonly failureMessage?: string;
}

/**
 * #716: Stripe customer details Feasly keeps in sync with the builder
 * profile — business name, contact email and builder id metadata (receipts,
 * tax and dispute evidence).
 */
export interface CustomerDetails {
  readonly tenantKey: string;
  /** Builder business name (Stripe `name`). */
  readonly name?: string;
  readonly email?: string;
  /** Builder row id (`metadata.feasly_builder_id`). */
  readonly builderId?: string;
}

/** Input for an off-session charge. */
export interface OffSessionChargeInput {
  readonly amountCents: number;
  readonly currency: string;
  readonly customerId: string;
  readonly description: string;
  /**
   * #716: text on the builder's bank statement (BILLING_STATEMENT_DESCRIPTOR).
   * Sent as Stripe's `statement_descriptor_suffix` — Stripe rejects
   * `statement_descriptor` on card PaymentIntents. Absent = account default.
   */
  readonly statementDescriptorSuffix?: string;
}

export interface PaymentProvider {
  /** Which implementation this is. */
  readonly name: PaymentProviderName;
  createCustomer(
    input: CustomerDetails,
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  /** #716: update the customer's name/email/builder metadata. */
  updateCustomer(customerId: string, input: CustomerDetails): Promise<void>;
  createSetupIntent(customerId: string): Promise<{
    id: string;
    clientSecret: string;
  }>;
  /**
   * Saved card payment methods for a customer, newest first. Only the
   * display-safe summary is exposed — never the PAN or full details.
   */
  listPaymentMethods(customerId: string): Promise<readonly CardSummary[]>;
  /**
   * #716: the customer's `invoice_settings.default_payment_method`, or null
   * when none is set (or the customer no longer exists).
   */
  getDefaultPaymentMethodId(customerId: string): Promise<string | null>;
  /** #716: make a saved card the customer's default payment method. */
  setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void>;
  /** Detach (remove) a saved payment method from its customer. */
  detachPaymentMethod(paymentMethodId: string): Promise<{ id: string }>;
  /**
   * Charge the customer off-session. #716: the card charged is the
   * customer's default payment method, named explicitly on the
   * PaymentIntent; the newest saved card only when no default is set. A
   * decline returns the PaymentIntent with its status (see the contract
   * above).
   */
  createOffSessionPaymentIntent(
    input: OffSessionChargeInput,
    idempotencyKey: string,
  ): Promise<{ id: string; status: string }>;
  /**
   * Refund a PaymentIntent — in full, or `amountCents` for a partial
   * refund. Idempotent via the idempotency key — timer/retry safe.
   */
  refundPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
    amountCents?: number,
  ): Promise<{ id: string; status: string }>;
  /**
   * Read a PaymentIntent's current status (#711 reconciliation). Read-only —
   * never confirms, captures, or cancels.
   */
  retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentStatus>;
  createSubscription(input: {
    customerId: string;
    priceId: string;
  }): Promise<{ id: string; status: string }>;
  cancelSubscription(subscriptionId: string): Promise<{ id: string }>;
  /**
   * Verify a webhook signature (Stripe's `t=…,v1=…` HMAC scheme) and
   * normalize the event. Throws on a bad signature.
   */
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
    webhookSecret: string,
  ): NormalizedStripeEvent;
}

/**
 * Normalize a Stripe-shaped event JSON (`{ id, type, data: { object } }`).
 * Shared by both providers so a simulated event is read exactly like a real
 * one.
 */
export function normalizeStripeEvent(event: {
  id: string;
  type: string;
  data?: { object?: unknown; previous_attributes?: unknown };
}): NormalizedStripeEvent {
  const data = (event.data?.object ?? {}) as Record<string, unknown>;
  const previous = (
    typeof event.data?.previous_attributes === 'object' &&
    event.data.previous_attributes !== null
      ? event.data.previous_attributes
      : {}
  ) as Record<string, unknown>;
  // #716: customer.created|updated|deleted carry the customer itself.
  const isCustomerObject =
    event.type.startsWith('customer.') &&
    !event.type.startsWith('customer.subscription.');
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  // payment_intent.payment_failed carries the decline reason under
  // data.object.last_payment_error.message (BILL-03).
  // #716: setup_intent.setup_failed carries it under last_setup_error.
  const errorField =
    event.type === 'payment_intent.payment_failed'
      ? 'last_payment_error'
      : event.type === 'setup_intent.setup_failed'
        ? 'last_setup_error'
        : null;
  const lastError =
    errorField !== null &&
    typeof data[errorField] === 'object' &&
    data[errorField] !== null
      ? (data[errorField] as Record<string, unknown>)
      : null;
  return {
    id: event.id,
    type: event.type,
    // charge.* (refunds, disputes) reference their PaymentIntent by id.
    paymentIntentId: event.type.startsWith('payment_intent.')
      ? str(data['id'])
      : event.type.startsWith('charge.')
        ? str(data['payment_intent'])
        : undefined,
    customerId: isCustomerObject
      ? str(data['id'])
      : (str(data['customer']) ??
        (typeof data['customer'] === 'object' && data['customer'] !== null
          ? str((data['customer'] as Record<string, unknown>)['id'])
          : undefined) ??
        // #716: payment_method.detached clears `customer`; Stripe keeps the
        // previous owner in data.previous_attributes.customer.
        str(previous['customer'])),
    subscriptionId: event.type.startsWith('customer.subscription.')
      ? str(data['id'])
      : str(data['subscription']),
    invoiceId: event.type.startsWith('invoice.')
      ? str(data['id'])
      : undefined,
    paymentMethodId: event.type.startsWith('payment_method.')
      ? str(data['id'])
      : event.type.startsWith('setup_intent.')
        ? // #716: the card a SetupIntent saved (expanded or id).
          (str(data['payment_method']) ??
          (typeof data['payment_method'] === 'object' &&
          data['payment_method'] !== null
            ? str((data['payment_method'] as Record<string, unknown>)['id'])
            : undefined))
        : undefined,
    failureMessage: lastError ? str(lastError['message']) : undefined,
  };
}
