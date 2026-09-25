/**
 * Thin Stripe-webhook route (billing/02).
 *
 * POST /api/v1/stripe/webhooks — validate input → call exactly one service
 * method → return the result. The raw request body (Buffer) is required:
 * Stripe signature verification needs the exact bytes Stripe signed, so the
 * function adapter must pass `req` through with `dataType: 'binary'` and
 * must NOT JSON-parse before this route runs.
 *
 * Auth is the Stripe signature itself (registry: `stripe-signature`) plus
 * the dedicated tight rate limiter on the webhook pipeline — no bearer
 * token exists for Stripe callbacks by design.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { StripeWebhookResult } from '@feasly/contracts';
import type { BillingWebhookService } from '../services/billing/billing-webhook.service';

export interface StripeWebhooksRouteDeps {
  readonly billingWebhooks: BillingWebhookService;
}

export interface StripeWebhooksRoute {
  /**
   * Handle one Stripe webhook delivery. `rawBody` must be the raw request
   * bytes; `signature` is the `Stripe-Signature` header value.
   */
  handle(
    rawBody: unknown,
    signature: string | undefined,
  ): Promise<StripeWebhookResult>;
}

export function createStripeWebhooksRoute(
  deps: StripeWebhooksRouteDeps,
): StripeWebhooksRoute {
  return {
    handle: (rawBody: unknown, signature: string | undefined) =>
      deps.billingWebhooks.handleWebhook(rawBody as Buffer, signature),
  };
}
