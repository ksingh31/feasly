/**
 * Azure Functions v3 trigger adapter — POST /api/v1/builder/users/invite.
 *
 * Invite a team member into the caller's org. Roles are forced to builder
 * roles (`builder_admin` | `builder_member`); the builder id comes from
 * the SESSION — a client-supplied id is ignored (enforced by the route).
 *
 * Requires the `builder:users:manage` permission (`builder_admin` only);
 * the registry enforces it before the route runs.
 *
 * Bundled by `npm run bundle:functions` into `builder-users-invite/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderUsersInviteHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderUsersRoute.invite(req.headers ?? {}, req.body ?? {}),
    { path: '/api/v1/builder/users/invite' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderUsersInviteHandler;
