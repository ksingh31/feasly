/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/auth/logout.
 *
 * Revokes the session and clears the cookie. Idempotent: logging out
 * without a session still returns success with a clearing cookie.
 *
 * Bundled by `npm run bundle:functions` into `admin-auth-logout/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminAuth,
  type FunctionContext,
  type FunctionRequest,
} from './admin-auth/shared';

export async function adminAuthLogoutHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminAuth(context, req, (app) =>
    app.adminAuthRoute.logout(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminAuthLogoutHandler;
