/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/retry.
 *
 * Admin-only: retry a failed commission charge (BILL-03). Creates a new
 * off-session PaymentIntent against the tenant's saved card with a distinct
 * idempotency key and moves the invoice `failed → in_review`, where the
 * existing webhook path settles paid/failed.
 *
 * Bundled by `npm run bundle:functions` into `admin-billing-retry/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingRetryHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(context, req, (app) =>
    app.adminBillingRoute.retryCharge(
      req.headers ?? {},
      context.bindingData?.['id'],
    ),
    { path: '/api/v1/admin/billing/invoices/{id}/retry' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingRetryHandler;
