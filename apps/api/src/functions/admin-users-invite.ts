/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/users/invite.
 *
 * Invite a user by email (Graph account + invitation row + branded email).
 * Staff (`users:manage`) may grant any role; builder admins
 * (`builder:users:manage`) may only invite builder roles into their own
 * orgs — enforced by the registry (OR) and the route (scoping).
 *
 * Bundled by `npm run bundle:functions` into `admin-users-invite/index.js`.
 */
import {
  dispatchAdminUsers,
  type FunctionContext,
  type FunctionRequest,
} from './admin-users/shared';

export async function adminUsersInviteHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminUsers(
    context,
    req,
    (app) => app.adminUsersRoute.invite(req.headers ?? {}, req.body),
    { path: '/api/v1/admin/users/invite' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminUsersInviteHandler;
