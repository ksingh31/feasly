/**
 * Charge-outcome classification (#712). Pure — no I/O.
 *
 * Maps what a payment provider reported about one off-session charge
 * attempt (Stripe's PaymentIntent status, plus the card-error code when the
 * confirm was rejected) to the normalised `ChargeOutcome` the commission
 * engine acts on.
 *
 * Stripe specifics this encodes:
 * - An off-session confirm that needs 3-D Secure is REJECTED with error
 *   code `authentication_required` and leaves the PaymentIntent in
 *   `requires_payment_method` — it is recoverable on-session, so it is
 *   `requires_action`, not a decline.
 * - `requires_action` / `requires_confirmation` (simulated provider, and
 *   Stripe when the intent is left for the client) → `requires_action`.
 * - `requires_payment_method` / `canceled` → `failed` (declined).
 * - `succeeded` → `succeeded`.
 * - Anything else (`processing`, `requires_capture`, unknown) → `processing`:
 *   the webhook or #711 reconciliation settles it later. Never guess a
 *   failure from an unknown status — that would email a decline for money
 *   that may still arrive.
 */
import type { ChargeOutcome } from '@feasly/contracts';

/** Stripe card-error code for an off-session charge needing 3DS. */
export const AUTHENTICATION_REQUIRED_CODE = 'authentication_required';

export interface ChargeAttemptReport {
  /** Provider PaymentIntent status (Stripe vocabulary). */
  readonly status: string;
  /** Card-error `code` when the confirm was rejected (e.g. `card_declined`). */
  readonly errorCode?: string;
}

export function classifyChargeOutcome(report: ChargeAttemptReport): ChargeOutcome {
  if (report.errorCode === AUTHENTICATION_REQUIRED_CODE) {
    return 'requires_action';
  }
  switch (report.status) {
    case 'succeeded':
      return 'succeeded';
    case 'requires_action':
    case 'requires_confirmation':
      return 'requires_action';
    case 'requires_payment_method':
    case 'canceled':
      return 'failed';
    default:
      return 'processing';
  }
}
