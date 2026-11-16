/**
 * Azure Functions v3 trigger adapter — GET + DELETE /api/v1/billing/card.
 *
 * GET: builder reads their card-on-file status (brand/last4/expiry only —
 * the PAN never leaves Stripe). DELETE (#716): builder admin removes the
 * card on file. Commission model.
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
  if ((req.method ?? 'GET').toUpperCase() === 'DELETE') {
    await dispatchBilling(
      context,
      req,
      (app) => app.billingRoute.removeCard(req.headers ?? {}),
      { path: '/api/v1/billing/card' },
    );
    return;
  }
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.getCard(req.headers ?? {}),
    { path: '/api/v1/billing/card' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingCardHandler;
