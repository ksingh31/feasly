/**
 * Azure Functions v3 trigger adapter — POST /api/v1/billing/setup-intent.
 *
 * Builder creates a SetupIntent to save a card on file (commission model).
 * Idempotent: ensures the tenant's Stripe customer first, so the portal
 * needs only one call to start the Stripe Elements card form.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingSetupIntentHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.createSetupIntent(req.headers ?? {}),
    { path: '/api/v1/billing/setup-intent' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingSetupIntentHandler;
