/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/api-keys/{id}/revoke.
 *
 * Revokes an API key immediately (admin-only). The key 401s on its next use.
 *
 * Bundled by `npm run bundle:functions` into `api-keys-revoke/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchApiKeys,
  type FunctionContext,
  type FunctionRequest,
} from './api-keys/shared';

export async function apiKeysRevokeHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const id = context.bindingData?.['id'];
  await dispatchApiKeys(context, req, (app) =>
    app.apiKeyRoute.revoke(req.headers ?? {}, typeof id === 'string' ? id : ''),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = apiKeysRevokeHandler;
