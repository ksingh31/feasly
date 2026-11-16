/**
 * Azure Functions v3 trigger adapter — PATCH /api/v1/admin/partners/{id} (#888).
 *
 * Edit / deactivate / reorder a builder partner. Admin-gated via the
 * session-cookie AdminGuard (inside the route) and the registry
 * permissions (enforced by the shared dispatch).
 *
 * Bundled by `npm run bundle:functions` into `admin-partners-detail/index.js`.
 */
import {
  dispatchAdminBuilders,
  type FunctionContext,
  type FunctionRequest,
} from './admin-builders/shared';

export async function adminPartnersDetailHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBuilders(
    context,
    req,
    (app) =>
      app.adminPartnersRoute.update(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/partners/{id}' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminPartnersDetailHandler;
