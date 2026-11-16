/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/billing/simulated/confirm-setup (#753).
 *
 * Builder saves a test card against their SetupIntent while the simulated
 * payment provider is active (stand-in for Stripe Elements). 404 when
 * PAYMENTS_PROVIDER=stripe.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingSimulatedConfirmSetupHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.simulatedPaymentsRoute.confirmSetup(req.headers ?? {}, req.body),
    { path: '/api/v1/billing/simulated/confirm-setup' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingSimulatedConfirmSetupHandler;
