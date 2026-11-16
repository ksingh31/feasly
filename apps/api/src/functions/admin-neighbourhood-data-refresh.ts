/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/neighbourhood-data/{provider}/refresh (#773).
 *
 * Admin "refresh now" for one neighbourhood data provider. Admin-gated via
 * the session-cookie AdminGuard (inside the route) and the registry
 * permissions (enforced by the shared dispatch). Audit-logged by the route.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-neighbourhood-data-refresh/index.js`.
 */
import {
  dispatchAdminBuilders,
  type FunctionContext,
  type FunctionRequest,
} from './admin-builders/shared';

export async function adminNeighbourhoodDataRefreshHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBuilders(
    context,
    req,
    (app) =>
      app.adminNeighbourhoodDataRoute.refresh(
        req.headers ?? {},
        context.bindingData?.['provider'],
      ),
    { path: '/api/v1/admin/neighbourhood-data/{provider}/refresh' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminNeighbourhoodDataRefreshHandler;
