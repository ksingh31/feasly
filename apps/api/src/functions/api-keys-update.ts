/**
 * Azure Functions v3 trigger adapter —
 * PATCH /api/v1/admin/api-keys/{id}.
 *
 * Updates an API key's scopes and/or rate limit (admin-only). Changes take
 * effect on the next request — the auth middleware reads the row fresh from
 * the DB on every call (no caching).
 *
 * Bundled by `npm run bundle:functions` into `api-keys-update/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchApiKeys,
  type FunctionContext,
  type FunctionRequest,
} from './api-keys/shared';

export async function apiKeysUpdateHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const id = context.bindingData?.['id'];
  await dispatchApiKeys(context, req, (app) =>
    app.apiKeyRoute.update(
      req.headers ?? {},
      typeof id === 'string' ? id : '',
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = apiKeysUpdateHandler;
