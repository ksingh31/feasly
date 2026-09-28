/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/users.
 *
 * List org users (active org from the session). Invites go through the
 * dedicated POST /api/v1/builder/users/invite binding (same as the admin
 * users pattern).
 *
 * Requires the `builder:users:manage` permission (`builder_admin` only);
 * the registry enforces it before the route runs.
 *
 * Bundled by `npm run bundle:functions` into `builder-users/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderUsersHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderUsersRoute.list(req.headers ?? {}),
    { path: '/api/v1/builder/users' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderUsersHandler;
