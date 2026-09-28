/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/auth/memberships.
 *
 * Returns the caller's org memberships plus the session's active builder.
 * Requires a builder session (enforced by the route via the permission
 * guard); the registry marks it `builder_session` auth.
 *
 * Bundled by `npm run bundle:functions` into `builder-auth-memberships/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAuthMembershipsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderEntraCallbackRoute.memberships(req.headers ?? {}),
    { path: '/api/v1/builder/auth/memberships' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAuthMembershipsHandler;
