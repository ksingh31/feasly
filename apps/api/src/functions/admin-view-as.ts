/**
 * Azure Functions v3 trigger adapter — POST/DELETE /api/v1/admin/view-as.
 *
 * View-as activation (auth/04): requires the `view_as` permission
 * (super_admin/admin) — enforced by the route via requirePermission, which
 * also resolves the session. While active, the session's effective
 * permissions + tenant scoping resolve to the target's view; every
 * activation and exit is audit-logged under the real admin's identity.
 *
 * Bundled by `npm run bundle:functions` into `admin-view-as/index.js`.
 */
import {
  dispatchAdminAuth,
  type FunctionContext,
  type FunctionRequest,
} from './admin-auth/shared';
import { HttpError, ErrorCodes } from '../middleware/errors';

export async function adminViewAsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  await dispatchAdminAuth(
    context,
    req,
    (app) => {
      if (method === 'POST') {
        return app.adminViewAsRoute.activate(req.headers ?? {}, req.body);
      }
      if (method === 'DELETE') {
        return app.adminViewAsRoute.exit(req.headers ?? {});
      }
      throw new HttpError(
        405,
        ErrorCodes.VALIDATION_FAILED,
        'Method not allowed.',
        false,
      );
    },
    { requireAuth: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminViewAsHandler;
