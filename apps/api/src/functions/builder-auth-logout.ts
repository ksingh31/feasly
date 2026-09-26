/**
 * Azure Functions v3 trigger adapter — POST /api/v1/builder/auth/logout.
 *
 * Revokes the builder session. The adapter clears the session cookie via
 * the `Set-Cookie` header.
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAuthLogoutHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(context, req, (app) =>
    app.builderAuthRoute.logout(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAuthLogoutHandler;
