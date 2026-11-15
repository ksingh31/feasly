/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/billing/overview.
 *
 * Builder portal Money page header (#531): outstanding total, next card
 * auto-charge, failed invoices, plan type + rate, card on file — one call.
 * Tenant-scoped to the builder session.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function builderBillingOverviewHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.builderBillingOverviewRoute.getOverview(req.headers ?? {}),
    { path: '/api/v1/builder/billing/overview' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderBillingOverviewHandler;
