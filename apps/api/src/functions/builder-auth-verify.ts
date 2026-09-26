/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/auth/verify.
 *
 * Consumes the magic link, creates the builder session. The adapter sets
 * the session as an httpOnly cookie via the `Set-Cookie` header.
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAuthVerifyHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(context, req, (app) =>
    app.builderAuthRoute.verify(req.query ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAuthVerifyHandler;
