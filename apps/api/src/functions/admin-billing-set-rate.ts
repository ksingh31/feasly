/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/commission-rate.
 *
 * Admin-only: override the per-invoice commission rate (percent, e.g.
 * 1.5 = 1.5%) and recalculate the invoice amount. Unpaid invoices only —
 * a settled invoice is never silently repriced.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-set-rate/index.js` (self-contained — the Function App
 * has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingSetRateHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.setCommissionRate(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/billing/invoices/{id}/commission-rate' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingSetRateHandler;
