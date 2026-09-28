/**
 * Azure Functions v3 trigger adapter — /api/v1/builder/users/{id}.
 *
 * - PATCH → rename / change org role / activate / disable. Disabling
 *   kills the user's builder sessions immediately.
 * - DELETE → remove from the org (membership revoked; row disabled when
 *   it's the last membership). Sessions revoked immediately.
 *
 * Requires the `builder:users:manage` permission (`builder_admin` only);
 * the registry enforces it before the route runs. The target must hold
 * a membership in the caller's active org (enforced by the route).
 *
 * Bundled by `npm run bundle:functions` into `builder-users-id/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderUsersIdHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const id = context.bindingData?.['id'];
  await dispatchBuilderAuth(
    context,
    req,
    (app) => {
      if (method === 'DELETE') {
        return app.builderUsersRoute.remove(req.headers ?? {}, id);
      }
      return app.builderUsersRoute.update(
        req.headers ?? {},
        id,
        req.body ?? {},
      );
    },
    { path: '/api/v1/builder/users/{id}' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderUsersIdHandler;
