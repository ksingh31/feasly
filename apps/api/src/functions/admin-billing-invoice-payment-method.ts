/**
 * Azure Functions v3 trigger adapter —
 * PUT /api/v1/admin/billing/invoices/{id}/payment-method.
 *
 * Admin-only: change the planned payment method on one commission
 * invoice (card, cheque, e_transfer, bank_draft). Unpaid invoices only
 * (draft, in_review, failed); 409 otherwise. Choosing a manual method
 * pauses the Stripe auto-charge until staff marks the invoice paid.
 * Audited with the admin identity.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-invoice-payment-method/index.js` (self-contained — the
 * Function App has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingInvoicePaymentMethodHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.setInvoicePaymentMethod(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/billing/invoices/{id}/payment-method' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingInvoicePaymentMethodHandler;
