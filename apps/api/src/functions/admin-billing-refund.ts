/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/refund.
 *
 * Admin-only (#715): refund a paid commission invoice in full or in part.
 * Card-paid invoices are refunded on the payment provider; manually paid
 * invoices record an off-Stripe refund. Idempotent on the client key.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-refund/index.js` (self-contained — the Function App
 * has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingRefundHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.refundInvoice(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/billing/invoices/{id}/refund' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingRefundHandler;
