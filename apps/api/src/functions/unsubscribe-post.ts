/**
 * Azure Functions v3 trigger adapter — POST /api/v1/unsubscribe/{token}.
 *
 * Records the CASL opt-out (`leads.unsubscribed_at`). Idempotent: a second
 * POST with the same token keeps the first timestamp. The token is NEVER
 * logged (PII-grade bearer credential).
 *
 * Bundled by `npm run bundle:functions` into `unsubscribe-post/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchUnsubscribe,
  type FunctionContext,
  type FunctionRequest,
} from './unsubscribe/shared';

export async function unsubscribePostHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const token = context.bindingData?.['token'];
  await dispatchUnsubscribe(context, req, (app) =>
    app.unsubscribeRoute.unsubscribe(typeof token === 'string' ? token : ''),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = unsubscribePostHandler;
