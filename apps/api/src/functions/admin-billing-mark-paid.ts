/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/mark-paid.
 *
 * Admin-only: record an off-Stripe payment (cheque, bank draft, e-transfer,
 * cash, separate card terminal…) for a commission invoice. Marks the
 * invoice paid AND cancels the scheduled auto-charge — the builder can
 * never be double-charged.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-mark-paid/index.js` (self-contained — the Function App
 * has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingMarkPaidHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.markPaid(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/billing/invoices/{id}/mark-paid' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingMarkPaidHandler;
