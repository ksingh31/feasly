/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/disputes/{id}/accept.
 *
 * Admin-only: accept the dispute — voids the invoice, refunding the
 * PaymentIntent first when it was already paid (credit note). Audit-logged.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-disputes-accept/index.js` (self-contained — the Function App has
 * no node_modules).
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function adminDisputesAcceptHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.adminDisputesRoute.acceptDispute(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminDisputesAcceptHandler;
