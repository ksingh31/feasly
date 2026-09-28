/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/auth/switch-builder.
 *
 * Org switcher (auth/04): switches the session's active builder. The route
 * 403s unless the builder is one of the caller's memberships — the builder
 * is never taken from request input beyond the validated membership check,
 * and tenant scoping always reads the server-side session state.
 * Audit-logged under the caller's identity.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-auth-switch-builder/index.js`.
 */
import {
  dispatchAdminAuth,
  type FunctionContext,
  type FunctionRequest,
} from './admin-auth/shared';

export async function adminAuthSwitchBuilderHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminAuth(
    context,
    req,
    (app) => app.adminViewAsRoute.switchBuilder(req.headers ?? {}, req.body),
    { requireAuth: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminAuthSwitchBuilderHandler;
