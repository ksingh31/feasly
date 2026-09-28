/**
 * Azure Functions v3 trigger adapter — GET/POST /api/v1/admin/builders.
 *
 * List all builders / create a builder. Admin-gated via the
 * session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-builders/index.js`.
 */
import {
  dispatchAdminBuilders,
  type FunctionContext,
  type FunctionRequest,
} from './admin-builders/shared';

export async function adminBuildersHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  await dispatchAdminBuilders(context, req, (app) => {
    if (method === 'POST') {
      return app.adminBuildersRoute.create(req.headers ?? {}, req.body);
    }
    return app.adminBuildersRoute.list(req.headers ?? {});
  },
    { path: '/api/v1/admin/builders' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBuildersHandler;
