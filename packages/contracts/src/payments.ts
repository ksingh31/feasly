/**
 * Payment provider contracts (#753).
 *
 * Billing runs against a `PaymentProvider`: the real Stripe provider, or a
 * Stripe-shaped simulated provider used until a Stripe account exists. The
 * simulated provider mirrors Stripe's object shapes, status names, event
 * types and test card numbers, so going live is a config + Key Vault change.
 *
 * Shapes only: no logic, no secrets, no real card data. The test card
 * numbers below are Stripe's public test numbers — they can never charge.
 */

/** Which provider the API is wired to (`PAYMENTS_PROVIDER`). */
export type PaymentProviderName = 'stripe' | 'simulated';

/** What a simulated test card does when it is saved or charged. */
export type SimulatedCardBehavior =
  /** Saves and charges successfully. */
  | 'succeeds'
  /** Saves; every charge is declined (`card_declined`). */
  | 'card_declined'
  /** Saves; every charge is declined (`insufficient_funds`). */
  | 'insufficient_funds'
  /** Needs a 3D Secure challenge on save and on every charge. */
  | 'requires_3ds';

export interface SimulatedTestCard {
  /** Stripe's public test card number (digits only). */
  readonly number: string;
  readonly brand: string;
  readonly label: string;
  readonly behavior: SimulatedCardBehavior;
}

/**
 * Deterministic test cards (same numbers and outcomes as Stripe's test
 * mode). The builder card modal offers exactly these when the simulated
 * provider is active.
 */
export const SIMULATED_TEST_CARDS: readonly SimulatedTestCard[] = [
  {
    number: '4242424242424242',
    brand: 'visa',
    label: 'Visa — payment succeeds',
    behavior: 'succeeds',
  },
  {
    number: '4000000000000002',
    brand: 'visa',
    label: 'Visa — card declined',
    behavior: 'card_declined',
  },
  {
    number: '4000000000009995',
    brand: 'visa',
    label: 'Visa — insufficient funds',
    behavior: 'insufficient_funds',
  },
  {
    number: '4000002760003184',
    brand: 'visa',
    label: 'Visa — 3D Secure required',
    behavior: 'requires_3ds',
  },
] as const;

/** Banner copy for the simulated card field. */
export const SIMULATED_PAYMENTS_NOTICE = 'Test mode — no real charges';

/**
 * Body of POST /api/v1/billing/simulated/confirm-setup — the simulated
 * stand-in for Stripe Elements' `confirmCardSetup`.
 */
export interface SimulatedConfirmSetupRequest {
  readonly setupIntentId: string;
  /** One of `SIMULATED_TEST_CARDS[].number`. Anything else is rejected. */
  readonly cardNumber: string;
}

/** Stripe SetupIntent / PaymentIntent status names the simulation uses. */
export type SimulatedIntentStatus =
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'canceled';

export interface SimulatedIntentResponse {
  /** `seti_…` or `pi_…`. */
  readonly intentId: string;
  readonly status: SimulatedIntentStatus;
  /** Present when status is `requires_action`: complete the 3DS challenge. */
  readonly nextAction?: 'three_d_secure';
  /** Stripe-style decline message when the intent failed. */
  readonly lastErrorMessage?: string;
}

/**
 * Body of POST /api/v1/billing/simulated/authenticate — the dev-only
 * "complete 3DS challenge" step for a SetupIntent or PaymentIntent in
 * `requires_action`.
 */
export interface SimulatedAuthenticateRequest {
  readonly intentId: string;
  readonly outcome: 'complete' | 'fail';
}

/** What the admin dev panel can fire against an invoice's PaymentIntent. */
export type SimulatedInvoiceEventKind =
  | 'dispute'
  | 'refund'
  | 'delayed_failure';

/** Body of POST /api/v1/admin/billing/simulated/invoices/{id}/events. */
export interface SimulatedInvoiceEventRequest {
  readonly kind: SimulatedInvoiceEventKind;
  /** Refund only: partial amount in cents. Omit for a full refund. */
  readonly amountCents?: number;
}

export interface SimulatedInvoiceEventResponse {
  readonly invoiceId: string;
  readonly paymentIntentId: string;
  readonly kind: SimulatedInvoiceEventKind;
  /** Stripe event type delivered through the webhook handler. */
  readonly eventType: string;
}
