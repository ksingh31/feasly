/**
 * Azure Functions v3 trigger adapter — GET/POST /api/v1/admin/partners (#888).
 *
 * List every builder partner / add a partner. Admin-gated via the
 * session-cookie AdminGuard (inside the route) and the registry
 * permissions (enforced by the shared dispatch).
 *
 * Bundled by `npm run bundle:functions` into `admin-partners/index.js`.
 */
import {
  dispatchAdminBuilders,
  type FunctionContext,
  type FunctionRequest,
} from './admin-builders/shared';

export async function adminPartnersHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  await dispatchAdminBuilders(
    context,
    req,
    (app) => {
      if (method === 'POST') {
        return app.adminPartnersRoute.create(req.headers ?? {}, req.body);
      }
      return app.adminPartnersRoute.list(req.headers ?? {});
    },
    { path: '/api/v1/admin/partners' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminPartnersHandler;
