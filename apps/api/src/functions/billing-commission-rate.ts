/**
 * Azure Functions v3 trigger adapter — GET /api/v1/billing/commission-rate.
 *
 * Builder reads their org's negotiated commission rate (percent), for the
 * "Record signed contract" live preview (billing/08). Commission model.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingCommissionRateHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.getCommissionRate(req.headers ?? {}),
    { path: '/api/v1/billing/commission-rate' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingCommissionRateHandler;
