/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/users.
 *
 * Paginated user list (memberships included). Requires `users:manage`
 * (registry-enforced before the route runs).
 *
 * Bundled by `npm run bundle:functions` into `admin-users/index.js`.
 */
import {
  dispatchAdminUsers,
  type FunctionContext,
  type FunctionRequest,
} from './admin-users/shared';

export async function adminUsersHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminUsers(
    context,
    req,
    (app) => app.adminUsersRoute.list(req.headers ?? {}, req.query ?? {}),
    { path: '/api/v1/admin/users' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminUsersHandler;
