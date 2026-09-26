/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/billing/invoices/{id}/resolve.
 *
 * Admin-only: resolve a dispute — 'resume' puts the invoice back into
 * review with a fresh 7-day window, 'void' cancels it.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoiceResolveHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.resolveDispute(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoiceResolveHandler;
