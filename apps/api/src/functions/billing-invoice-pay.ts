/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/billing/invoices/{id}/pay (#718).
 *
 * Builder Pay now: charge a commission invoice whose card payment failed
 * against the card on file right away. Double submission returns the
 * invoice as it is — one charge. 409 unless the card payment failed, 403
 * for another tenant's invoice.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoicePayHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(
    context,
    req,
    (app) =>
      app.billingRoute.payInvoice(
        req.headers ?? {},
        context.bindingData?.['id'],
      ),
    { path: '/api/v1/billing/invoices/{id}/pay' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoicePayHandler;
