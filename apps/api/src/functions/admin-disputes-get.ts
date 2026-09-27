/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/disputes/{id}.
 *
 * Admin-only: one dispute's detail — immutable evidence snapshot,
 * SLA state, and the billing audit trail.
 *
 * Bundled by `npm run bundle:functions` into `admin-disputes-get/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function adminDisputesGetHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.adminDisputesRoute.getDispute(
      req.headers ?? {},
      context.bindingData?.['id'],
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminDisputesGetHandler;
