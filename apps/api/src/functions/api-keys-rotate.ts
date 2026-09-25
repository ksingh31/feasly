/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/api-keys/{id}/rotate.
 *
 * Rotates an API key (admin-only): revokes the old key immediately and
 * returns the new plaintext exactly once.
 *
 * Bundled by `npm run bundle:functions` into `api-keys-rotate/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchApiKeys,
  type FunctionContext,
  type FunctionRequest,
} from './api-keys/shared';

export async function apiKeysRotateHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const id = context.bindingData?.['id'];
  await dispatchApiKeys(context, req, (app) =>
    app.apiKeyRoute.rotate(req.headers ?? {}, typeof id === 'string' ? id : ''),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = apiKeysRotateHandler;
