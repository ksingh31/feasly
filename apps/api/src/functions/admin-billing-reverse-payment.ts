/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/reverse-payment.
 *
 * Admin-only (#715): reverse a manual mark-paid (bounced cheque) —
 * paid → failed with a mandatory reason.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-reverse-payment/index.js` (self-contained — the Function App
 * has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingReversePaymentHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.reverseManualPayment(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/billing/invoices/{id}/reverse-payment' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingReversePaymentHandler;
