/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/disputes.
 *
 * Admin-only: open disputes oldest-first with reason, the 5-business-day
 * SLA countdown (America/Edmonton), and breach flags.
 *
 * Bundled by `npm run bundle:functions` into `admin-disputes/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function adminDisputesHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.adminDisputesRoute.listDisputes(req.headers ?? {}),
    { path: '/api/v1/admin/disputes' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminDisputesHandler;
