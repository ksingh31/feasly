/**
 * Azure Functions v3 trigger adapter — GET /api/v1/billing/invoices.
 *
 * BILL-04: paginated invoice list, newest first. Builders see only their
 * own tenant's invoices; admins see all.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoiceListHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(
    context,
    req,
    (app) =>
      app.billingRoute.listInvoices(req.headers ?? {}, req.query ?? {}),
    { path: '/api/v1/billing/invoices' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoiceListHandler;
