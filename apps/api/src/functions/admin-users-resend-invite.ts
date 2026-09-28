/**
 * Azure Functions v3 trigger adapter — POST
 * /api/v1/admin/users/{id}/resend-invite.
 *
 * Re-issue a pending invitation (retries the Graph account create when
 * the first attempt failed). Same permission shape as invite: staff
 * (`users:manage`) or the user's own builder admin
 * (`builder:users:manage`).
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-users-resend-invite/index.js`.
 */
import {
  dispatchAdminUsers,
  type FunctionContext,
  type FunctionRequest,
} from './admin-users/shared';

export async function adminUsersResendInviteHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminUsers(
    context,
    req,
    (app) =>
      app.adminUsersRoute.resendInvite(
        req.headers ?? {},
        context.bindingData?.['id'],
      ),
    { path: '/api/v1/admin/users/{id}/resend-invite' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminUsersResendInviteHandler;
