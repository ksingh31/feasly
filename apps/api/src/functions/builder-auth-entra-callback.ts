/**
 * Azure Functions v3 trigger adapter — POST /api/v1/builder/auth/entra/callback.
 *
 * The backend half of builder Entra sign-in: the SPA POSTs the PKCE
 * authorization code, the route exchanges + validates it with the builder
 * Entra External ID app, resolves the user's builder memberships, and
 * mints a builder session bound to the user id + active builder
 * (httpOnly `Set-Cookie` + the raw token in the JSON body for the SPA
 * Bearer <redacted>).
 *
 * Public by design (it IS the sign-in) with a dedicated tight pipeline:
 * 10 attempts per IP per 15 min — Entra owns credential brute-force; this
 * stops code-replay abuse.
 *
 * Bundled by `npm run bundle:functions` into `builder-auth-entra-callback/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAuthEntraCallbackHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderEntraCallbackRoute.callback(req.body ?? {}),
    {
      pipeline: (app) => app.builderEntraCallbackPipeline,
      path: '/api/v1/builder/auth/entra/callback',
    },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAuthEntraCallbackHandler;
