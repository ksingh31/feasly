/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/auth/me.
 *
 * Returns the current session identity. Requires a valid session cookie;
 * the adapter enforces this via the admin guard before calling the route.
 *
 * Bundled by `npm run bundle:functions` into `admin-auth-me/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminAuth,
  type FunctionContext,
  type FunctionRequest,
} from './admin-auth/shared';

export async function adminAuthMeHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminAuth(
    context,
    req,
    (app) => app.adminAuthRoute.me(req.headers ?? {}),
    { requireAuth: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminAuthMeHandler;
