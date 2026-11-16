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
 * #712: the decline / 3DS details (`errorCode`, `declineCode`,
 * `failureMessage`) come back with it so the engine can settle the invoice
 * in the same step. Only transient errors (network, 5xx, rate limit) throw.
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

/** Metadata key carrying the commission invoice id on a PaymentIntent (#712). */
export const INVOICE_METADATA_KEY = 'feasly_commission_invoice_id';
/**
 * Metadata key carrying which charge attempt created a PaymentIntent (#712):
 * `0` = the first charge at finalize, `n` = admin retry n.
 */
export const CHARGE_ATTEMPT_METADATA_KEY = 'feasly_charge_attempt';

/**
 * Result of one off-session charge attempt (#712). A decline or a 3DS
 * demand is a result, not a thrown error — the PaymentIntent exists either
 * way and the invoice must record it.
 */
export interface OffSessionChargeResult {
  readonly id: string;
  /** Raw PaymentIntent status (`succeeded`, `requires_action`, …). */
  readonly status: string;
  /** Card-error code when the confirm was rejected (`card_declined`, `authentication_required`, …). */
  readonly errorCode?: string;
  /** Issuer decline code (`insufficient_funds`, `generic_decline`, …). */
  readonly declineCode?: string;
  /** Display-safe decline message (e.g. "Your card was declined."). */
  readonly failureMessage?: string;
}

/**
 * What the builder portal needs to confirm a PaymentIntent on-session
 * (3DS recovery, #712).
 */
export interface PaymentIntentConfirmation {
  readonly id: string;
  readonly status: string;
  readonly clientSecret: string;
  /** The card the charge used, re-supplied to `confirmCardPayment`. */
  readonly paymentMethodId?: string;
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
   * payment_intent.payment_failed only: Stripe's `last_payment_error`
   * message (e.g. "Your card was declined."). BILL-03 surfaces it in the
   * dunning queue as the last failure reason.
   */
  readonly failureMessage?: string;
  /** payment_intent.payment_failed only: issuer decline code (#712). */
  readonly declineCode?: string;
  /**
   * payment_intent.* only: the commission invoice the PaymentIntent was
   * created for (`metadata.feasly_commission_invoice_id`, #712). Lets the
   * webhook tell "charge still in flight" apart from a true orphan when the
   * event beats the charge call's own response.
   */
  readonly commissionInvoiceId?: string;
  /** payment_intent.* only: `metadata.feasly_charge_attempt` (#712). */
  readonly chargeAttempt?: number;
}

export interface PaymentProvider {
  /** Which implementation this is. */
  readonly name: PaymentProviderName;
  createCustomer(
    input: {
      tenantKey: string;
      email?: string;
    },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  createSetupIntent(customerId: string): Promise<{
    id: string;
    clientSecret: string;
  }>;
  /**
   * Saved card payment methods for a customer, newest first. Only the
   * display-safe summary is exposed — never the PAN or full details.
   */
  listPaymentMethods(customerId: string): Promise<readonly CardSummary[]>;
  /** Detach (remove) a saved payment method from its customer. */
  detachPaymentMethod(paymentMethodId: string): Promise<{ id: string }>;
  /**
   * Charge the customer's newest saved card off-session. A decline or a
   * 3DS demand returns the PaymentIntent with its status and error details
   * (see the contract above); only transient errors throw.
   */
  createOffSessionPaymentIntent(
    input: {
      amountCents: number;
      currency: string;
      customerId: string;
      description: string;
      /** Stored on the PaymentIntent (e.g. INVOICE_METADATA_KEY). */
      metadata?: Readonly<Record<string, string>>;
    },
    idempotencyKey: string,
  ): Promise<OffSessionChargeResult>;
  /**
   * #712: client secret (+ the card used) so the cardholder can confirm a
   * PaymentIntent on-session after the bank demanded 3DS. Read-only.
   */
  getPaymentIntentConfirmation(
    paymentIntentId: string,
  ): Promise<PaymentIntentConfirmation>;
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

/** `metadata.feasly_charge_attempt` of a payment_intent.* object, if numeric. */
function chargeAttemptOf(
  type: string,
  data: Record<string, unknown>,
): number | undefined {
  if (!type.startsWith('payment_intent.')) return undefined;
  const meta = data['metadata'];
  if (typeof meta !== 'object' || meta === null) return undefined;
  const raw = (meta as Record<string, unknown>)[CHARGE_ATTEMPT_METADATA_KEY];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * Normalize a Stripe-shaped event JSON (`{ id, type, data: { object } }`).
 * Shared by both providers so a simulated event is read exactly like a real
 * one.
 */
export function normalizeStripeEvent(event: {
  id: string;
  type: string;
  data?: { object?: unknown };
}): NormalizedStripeEvent {
  const data = (event.data?.object ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  // payment_intent.payment_failed carries the decline reason under
  // data.object.last_payment_error.message (BILL-03).
  const lastError =
    event.type === 'payment_intent.payment_failed' &&
    typeof data['last_payment_error'] === 'object' &&
    data['last_payment_error'] !== null
      ? (data['last_payment_error'] as Record<string, unknown>)
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
    failureMessage: lastError ? str(lastError['message']) : undefined,
    declineCode: lastError ? str(lastError['decline_code']) : undefined,
    commissionInvoiceId:
      event.type.startsWith('payment_intent.') &&
      typeof data['metadata'] === 'object' &&
      data['metadata'] !== null
        ? str((data['metadata'] as Record<string, unknown>)[INVOICE_METADATA_KEY])
        : undefined,
    chargeAttempt: chargeAttemptOf(event.type, data),
  };
}
