/**
 * Azure Functions v3 trigger adapter — POST/DELETE /api/v1/builder/view-as.
 *
 * Builder-side view-as activation (2026-09-30, Karan): a `builder_admin`
 * views the portal as a regular team member of their own org. Requires the
 * `view_as` permission (registry-enforced before the route runs); the
 * service additionally org-scopes targets and enforces the #394 admin-
 * target lockdown. Every activation and exit is audit-logged under the
 * real builder admin's identity.
 *
 * Bundled by `npm run bundle:functions` into `builder-view-as/index.js`.
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';
import { HttpError, ErrorCodes } from '../middleware/errors';

export async function builderViewAsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  await dispatchBuilderAuth(
    context,
    req,
    (app) => {
      if (method === 'POST') {
        return app.builderViewAsRoute.activate(req.headers ?? {}, req.body);
      }
      if (method === 'DELETE') {
        return app.builderViewAsRoute.exit(req.headers ?? {});
      }
      throw new HttpError(
        405,
        ErrorCodes.VALIDATION_FAILED,
        'Method not allowed.',
        false,
      );
    },
    { requireAuth: true, path: '/api/v1/builder/view-as' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderViewAsHandler;
