/**
 * Azure Functions v3 trigger adapter — POST /api/v1/builder/auth/request.
 *
 * Public by design (the allowlist check is the gate). Identical response
 * for allowlisted and non-allowlisted emails — no enumeration oracle.
 *
 * Bundled by `npm run bundle:functions` into `builder-auth-request/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAuthRequestHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(context, req, (app) =>
    app.builderAuthRoute.request(req.body),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAuthRequestHandler;
