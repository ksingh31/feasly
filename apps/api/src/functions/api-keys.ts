/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/api-keys.
 *
 * Issues a new API key (admin-only). The plaintext is returned exactly once
 * in this response; subsequent reads show only the masked prefix.
 *
 * Bundled by `npm run bundle:functions` into `api-keys/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchApiKeys,
  type FunctionContext,
  type FunctionRequest,
} from './api-keys/shared';

export async function apiKeysHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchApiKeys(context, req, (app) => {
    const method = req.method?.toUpperCase();
    if (method === 'GET') {
      return app.apiKeyRoute.list(req.headers ?? {});
    }
    return app.apiKeyRoute.issue(req.headers ?? {}, req.body);
  });
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = apiKeysHandler;
