/**
 * Azure Functions v3 trigger adapter — POST /api/v1/builder/auth/active-org.
 *
 * Switches the session's active builder (org switcher). The builder id
 * must be one of the caller's memberships, else 403. The session row is
 * updated server-side — the active org always comes from the session,
 * never a request param.
 *
 * Bundled by `npm run bundle:functions` into `builder-auth-active-org/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAuthActiveOrgHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) =>
      app.builderEntraCallbackRoute.setActiveOrg(
        req.headers ?? {},
        req.body ?? {},
      ),
    { path: '/api/v1/builder/auth/active-org' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAuthActiveOrgHandler;
