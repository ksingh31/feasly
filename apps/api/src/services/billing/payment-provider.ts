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
   * payment_intent.payment_failed only: Stripe's `last_payment_error`
   * message (e.g. "Your card was declined."). BILL-03 surfaces it in the
   * dunning queue as the last failure reason.
   */
  readonly failureMessage?: string;
  /** charge.dispute.* only (#719): the dispute fields billing records. */
  readonly dispute?: NormalizedDispute;
  /**
   * charge.refunded only (#719): Stripe's cumulative `amount_refunded` on
   * the charge, integer cents.
   */
  readonly amountRefundedCents?: number;
}

/** A Stripe dispute object, normalized (#719). */
export interface NormalizedDispute {
  /** `dp_…` */
  readonly id: string;
  /** Disputed amount, integer cents. */
  readonly amountCents: number | null;
  readonly currency: string | null;
  /** Reason code (fraudulent, product_not_received, …). */
  readonly reason: string | null;
  /** Raw status (warning_needs_response, needs_response, under_review, won, lost, warning_closed, …). */
  readonly status: string | null;
  /** `evidence_details.due_by` — the evidence deadline. */
  readonly evidenceDueAt: Date | null;
  readonly livemode: boolean | null;
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
   * Charge the customer's newest saved card off-session. A decline returns
   * the PaymentIntent with its status (see the contract above).
   */
  createOffSessionPaymentIntent(
    input: {
      amountCents: number;
      currency: string;
      customerId: string;
      description: string;
    },
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
    ...(event.type.startsWith('charge.dispute.') && str(data['id'])
      ? { dispute: normalizeDispute(data) }
      : {}),
    ...(event.type === 'charge.refunded' &&
    typeof data['amount_refunded'] === 'number'
      ? { amountRefundedCents: data['amount_refunded'] }
      : {}),
  };
}

function normalizeDispute(data: Record<string, unknown>): NormalizedDispute {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const evidence =
    typeof data['evidence_details'] === 'object' &&
    data['evidence_details'] !== null
      ? (data['evidence_details'] as Record<string, unknown>)
      : {};
  const dueBy = evidence['due_by'];
  return {
    id: str(data['id']) ?? '',
    amountCents:
      typeof data['amount'] === 'number' && Number.isInteger(data['amount'])
        ? data['amount']
        : null,
    currency: str(data['currency']),
    reason: str(data['reason']),
    status: str(data['status']),
    // Stripe sends unix seconds.
    evidenceDueAt:
      typeof dueBy === 'number' && Number.isFinite(dueBy)
        ? new Date(dueBy * 1000)
        : null,
    livemode: typeof data['livemode'] === 'boolean' ? data['livemode'] : null,
  };
}
