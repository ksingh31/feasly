/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/auth/entra/callback.
 *
 * The backend half of Entra sign-in: the SPA POSTs the PKCE authorization
 * code, the route exchanges + validates it with Entra, resolves our user,
 * and mints a 7-day admin session (httpOnly `Set-Cookie` + the raw token in
 * the JSON body for the SPA bearer flow).
 *
 * Public by design (it IS the sign-in) with a dedicated tight pipeline:
 * 10 attempts per IP per 15 min (frozen registry) — Entra owns credential
 * brute-force; this stops code-replay abuse.
 *
 * Bundled by `npm run bundle:functions` into `admin-auth-entra-callback/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminAuth,
  type FunctionContext,
  type FunctionRequest,
} from './admin-auth/shared';

export async function adminAuthEntraCallbackHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminAuth(
    context,
    req,
    (app) => app.entraCallbackRoute.callback(req.body ?? {}),
    { pipeline: (app) => app.entraCallbackPipeline },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminAuthEntraCallbackHandler;
