/**
 * Azure Functions v3 trigger adapter — GET /api/v1/billing/card.
 *
 * Builder reads their card-on-file status (brand/last4/expiry only — the
 * PAN never leaves Stripe). Commission model.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingCardHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.getCard(req.headers ?? {}),
    { path: '/api/v1/billing/card' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingCardHandler;
