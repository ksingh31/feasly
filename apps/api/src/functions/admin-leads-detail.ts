/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/leads/{id}.
 *
 * Full lead detail with estimate summary. Admin-gated via the
 * session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-leads-detail/index.js`.
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminLeadsDetailHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(context, req, (app) =>
    app.adminLeadsRoute.get(
      req.headers ?? {},
      context.bindingData?.['id'],
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadsDetailHandler;
