/**
 * Azure Functions v3 trigger adapter — GET /api/v1/billing/invoices/{id}.
 *
 * Builders see only their own tenant's invoices; admins see all.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoiceGetHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.getInvoice(
      req.headers ?? {},
      context.bindingData?.['id'],
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoiceGetHandler;
