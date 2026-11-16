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
  /**
   * `last_payment_error.code` (#712) — `authentication_required` means the
   * off-session charge needs 3DS (recoverable on-session), not a decline.
   */
  readonly lastPaymentErrorCode?: string;
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
   * payment_intent.payment_failed: Stripe's `last_payment_error` message
   * (e.g. "Your card was declined."). BILL-03 surfaces it in the dunning
   * queue as the last failure reason. setup_intent.setup_failed (#716):
   * `last_setup_error.message`.
   */
  readonly failureMessage?: string;
  /** payment_intent.payment_failed only: issuer decline code (#712). */
  readonly declineCode?: string;
  /**
   * payment_intent.payment_failed only: `last_payment_error.code` (#712).
   * Real Stripe reports an off-session 3DS demand as a payment_failed event
   * with code `authentication_required` — never as requires_action — so the
   * webhook must read this to keep the invoice recoverable.
   */
  readonly errorCode?: string;
  /**
   * payment_intent.* only: the commission invoice the PaymentIntent was
   * created for (`metadata.feasly_commission_invoice_id`, #712). Lets the
   * webhook tell "charge still in flight" apart from a true orphan when the
   * event beats the charge call's own response.
   */
  readonly commissionInvoiceId?: string;
  /** payment_intent.* only: `metadata.feasly_charge_attempt` (#712). */
  readonly chargeAttempt?: number;
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
  /** #712: stored on the PaymentIntent (e.g. INVOICE_METADATA_KEY). */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** #892: metadata key carrying the `billing_refunds.id` on a provider refund. */
export const REFUND_METADATA_KEY = 'feasly_refund_id';

/** #892: metadata Feasly stores on a provider refund. Ids only — never PII. */
export interface RefundMetadata {
  readonly [REFUND_METADATA_KEY]: string;
  readonly feasly_invoice_id?: string;
}

/** A provider refund: id + status (`pending` | `succeeded` | `failed` | `canceled` | …). */
export interface ProviderRefund {
  readonly id: string;
  readonly status: string;
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
   * decline or a 3DS demand (#712) returns the PaymentIntent with its
   * status and error details (see the contract above); only transient
   * errors throw.
   */
  createOffSessionPaymentIntent(
    input: OffSessionChargeInput,
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
   * refund. Idempotent via the idempotency key — timer/retry safe — but
   * only while the provider remembers the key (Stripe: ~24h). `metadata`
   * is stored on the refund (#892: `feasly_refund_id`) so a later resume
   * can find it with `findRefundByMetadata` after the key has expired.
   */
  refundPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
    amountCents?: number,
    metadata?: RefundMetadata,
  ): Promise<ProviderRefund>;
  /**
   * #892: the refund on this PaymentIntent whose metadata carries
   * `feasly_refund_id = feaslyRefundId`, or null when there is none.
   * Read-only. Called before resuming a `pending` refund row so a refund
   * whose first response was lost is adopted, never created twice.
   */
  findRefundByMetadata(
    paymentIntentId: string,
    feaslyRefundId: string,
  ): Promise<ProviderRefund | null>;
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
    declineCode: lastError ? str(lastError['decline_code']) : undefined,
    errorCode: lastError ? str(lastError['code']) : undefined,
    commissionInvoiceId:
      event.type.startsWith('payment_intent.') &&
      typeof data['metadata'] === 'object' &&
      data['metadata'] !== null
        ? str((data['metadata'] as Record<string, unknown>)[INVOICE_METADATA_KEY])
        : undefined,
    chargeAttempt: chargeAttemptOf(event.type, data),
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
