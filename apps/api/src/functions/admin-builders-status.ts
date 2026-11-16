/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/builders/{id}/status.
 *
 * Builder lifecycle action (#860): suspend / reactivate / start or complete
 * offboarding, reason required. Admin-gated (AdminGuard inside the route);
 * registry permissions (`builders:manage`) enforced by the dispatcher.
 *
 * Bundled by `npm run bundle:functions` into `admin-builders-status/index.js`.
 */
import {
  dispatchAdminBuilders,
  type FunctionContext,
  type FunctionRequest,
} from './admin-builders/shared';

export async function adminBuildersStatusHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBuilders(
    context,
    req,
    (app) =>
      app.adminBuildersRoute.changeStatus(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/builders/{id}/status' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBuildersStatusHandler;
