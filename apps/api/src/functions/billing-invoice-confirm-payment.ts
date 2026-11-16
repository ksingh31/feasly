/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/billing/invoices/{id}/confirm-payment (#712).
 *
 * SCA recovery: the bank demanded 3-D Secure on an off-session charge, so
 * the invoice is `action_required`. Returns the PaymentIntent client secret
 * (+ the card it used and the active provider) for the builder portal to
 * confirm the payment on-session. Read-only — the webhook settles the
 * invoice. 409 when the invoice is not waiting for confirmation, 403 for
 * another tenant's invoice.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoiceConfirmPaymentHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(
    context,
    req,
    (app) =>
      app.billingRoute.confirmInvoicePayment(
        req.headers ?? {},
        context.bindingData?.['id'],
      ),
    { path: '/api/v1/billing/invoices/{id}/confirm-payment' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoiceConfirmPaymentHandler;
