/**
 * Azure Functions v3 trigger adapter — GET/PATCH /api/v1/admin/builders/{id}.
 *
 * Get one builder / update a builder. Admin-gated via the
 * session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-builders-detail/index.js`.
 */
import {
  dispatchAdminBuilders,
  type FunctionContext,
  type FunctionRequest,
} from './admin-builders/shared';

export async function adminBuildersDetailHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  await dispatchAdminBuilders(context, req, (app) => {
    if (method === 'PATCH') {
      return app.adminBuildersRoute.update(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      );
    }
    return app.adminBuildersRoute.get(
      req.headers ?? {},
      context.bindingData?.['id'],
    );
  });
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBuildersDetailHandler;
