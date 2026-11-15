/**
 * Azure Functions v3 trigger adapter — GET /api/v1/billing/invoices/{id}/pdf.
 *
 * #661: the invoice (with a receipt block when paid) as a PDF download.
 * Builders see only their own tenant's invoices (404 otherwise); admins
 * see all. Returns raw `application/pdf` bytes.
 *
 * Bundled by `npm run bundle:functions` into `billing-invoice-pdf/index.js`.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoicePdfHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(
    context,
    req,
    (app) =>
      app.billingRoute.getInvoicePdf(
        req.headers ?? {},
        context.bindingData?.['id'],
      ),
    { path: '/api/v1/billing/invoices/{id}/pdf', pdf: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoicePdfHandler;
