/**
 * Azure Functions v3 trigger adapter — PATCH /api/v1/admin/leads/{id}/status.
 *
 * Pipeline status transition (writes history + audit). Admin-gated via the
 * session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-leads-status/index.js`.
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminLeadsStatusHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(context, req, (app) =>
    app.adminLeadsRoute.updateStatus(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadsStatusHandler;
