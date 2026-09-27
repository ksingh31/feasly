/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/disputes/{id}/reject.
 *
 * Admin-only: reject the dispute — the invoice goes back to in_review
 * with a fresh 7-day window. Audit-logged.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-disputes-reject/index.js` (self-contained — the Function App has
 * no node_modules).
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function adminDisputesRejectHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.adminDisputesRoute.rejectDispute(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminDisputesRejectHandler;
