/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/billing/simulated/authenticate (#753).
 *
 * Dev-only "complete 3DS challenge": the builder completes or fails the
 * 3D Secure step on a SetupIntent / PaymentIntent in requires_action. 404
 * when PAYMENTS_PROVIDER=stripe.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingSimulatedAuthenticateHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.simulatedPaymentsRoute.authenticate(req.headers ?? {}, req.body),
    { path: '/api/v1/billing/simulated/authenticate' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingSimulatedAuthenticateHandler;
