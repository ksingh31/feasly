/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/auth/me.
 *
 * Returns the session identity. Requires a valid builder session.
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAuthMeHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderAuthRoute.me(req.headers ?? {}),
    { requireAuth: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAuthMeHandler;
