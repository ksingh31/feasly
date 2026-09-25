/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/leads.
 *
 * Filtered lead listing with cursor pagination. Admin-gated via the
 * session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-leads/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminLeadsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(context, req, (app) =>
    app.adminLeadsRoute.list(req.headers ?? {}, req.query ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadsHandler;
