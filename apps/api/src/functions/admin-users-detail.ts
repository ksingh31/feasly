/**
 * Azure Functions v3 trigger adapter — GET/PATCH/DELETE
 * /api/v1/admin/users/{id}.
 *
 * Get one user / update (name, staff role, status, memberships) / hard
 * delete (only never-accepted users; everyone else is deactivated via
 * PATCH). PATCH accepts `builder:users:manage` too, scoped to the
 * caller's own orgs; GET and DELETE are staff-only (`users:manage`).
 *
 * Bundled by `npm run bundle:functions` into `admin-users-detail/index.js`.
 */
import {
  dispatchAdminUsers,
  type FunctionContext,
  type FunctionRequest,
} from './admin-users/shared';
import { HttpError, ErrorCodes } from '../middleware/errors';

export async function adminUsersDetailHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  await dispatchAdminUsers(
    context,
    req,
    (app) => {
      const id = context.bindingData?.['id'];
      if (method === 'PATCH') {
        return app.adminUsersRoute.update(req.headers ?? {}, id, req.body);
      }
      if (method === 'DELETE') {
        return app.adminUsersRoute.remove(req.headers ?? {}, id);
      }
      if (method === 'GET') {
        return app.adminUsersRoute.get(req.headers ?? {}, id);
      }
      throw new HttpError(
        405,
        ErrorCodes.VALIDATION_FAILED,
        'Method not allowed.',
        false,
      );
    },
    { path: '/api/v1/admin/users/{id}' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminUsersDetailHandler;
