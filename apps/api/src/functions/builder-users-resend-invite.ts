/**
 * Azure Functions v3 trigger adapter — POST
 * /api/v1/builder/users/{id}/resend-invite (#535).
 *
 * Re-issue a pending invitation for a member of the session's active org
 * who never accepted. Requires `builder:users:manage` (`builder_admin`
 * only); the registry enforces it before the route runs, and the route
 * enforces org membership + `invited` status.
 *
 * Bundled by `npm run bundle:functions` into
 * `builder-users-resend-invite/index.js` (self-contained).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderUsersResendInviteHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) =>
      app.builderUsersRoute.resendInvite(
        req.headers ?? {},
        context.bindingData?.['id'],
      ),
    { path: '/api/v1/builder/users/{id}/resend-invite' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderUsersResendInviteHandler;
