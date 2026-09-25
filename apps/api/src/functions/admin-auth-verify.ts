/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/auth/verify.
 *
 * Consumes the admin magic-link token and establishes the session via an
 * httpOnly `Set-Cookie` header. The token is single-use; replay attempts
 * get the uniform 401.
 *
 * Bundled by `npm run bundle:functions` into `admin-auth-verify/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminAuth,
  type FunctionContext,
  type FunctionRequest,
} from './admin-auth/shared';

export async function adminAuthVerifyHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminAuth(context, req, (app) =>
    app.adminAuthRoute.verify(req.query ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminAuthVerifyHandler;
