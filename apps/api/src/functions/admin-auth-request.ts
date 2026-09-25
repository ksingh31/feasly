/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/auth/request.
 *
 * Public by design (the allowlist check is the gate). Identical response
 * for allowlisted and non-allowlisted emails — no enumeration oracle.
 *
 * Bundled by `npm run bundle:functions` into `admin-auth-request/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminAuth,
  type FunctionContext,
  type FunctionRequest,
} from './admin-auth/shared';

export async function adminAuthRequestHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminAuth(context, req, (app) =>
    app.adminAuthRoute.request(req.body),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminAuthRequestHandler;
