/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/billing/invoices/{id}/dispute.
 *
 * Builder disputes their own invoice: the charge clock freezes and ops is
 * alerted. Tenant-scoped — cross-tenant disputes are 403.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingInvoiceDisputeHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.disputeInvoice(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoiceDisputeHandler;
