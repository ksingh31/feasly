/**
 * Azure Functions v3 trigger adapter —
 * PUT /api/v1/billing/invoices/{id}/payment-method.
 *
 * Builder changes the payment method on one of their invoices
 * (billing/12). Allowed while the invoice is unpaid (draft, in_review,
 * failed); 409 otherwise, 403 for another tenant's invoice. Choosing a
 * manual method pauses the Stripe auto-charge — the invoice-reviewer
 * timer skips non-card invoices until staff marks them paid.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoicePaymentMethodHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(
    context,
    req,
    (app) =>
      app.billingRoute.setInvoicePaymentMethod(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/billing/invoices/{id}/payment-method' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoicePaymentMethodHandler;
