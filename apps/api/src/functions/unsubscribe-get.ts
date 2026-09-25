/**
 * Azure Functions v3 trigger adapter — GET /api/v1/unsubscribe/{token}.
 *
 * Read-only: returns the confirmation-page state for the token. The token
 * is NEVER logged (PII-grade bearer credential).
 *
 * Bundled by `npm run bundle:functions` into `unsubscribe-get/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchUnsubscribe,
  type FunctionContext,
  type FunctionRequest,
} from './unsubscribe/shared';

export async function unsubscribeGetHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const token = context.bindingData?.['token'];
  await dispatchUnsubscribe(context, req, (app) =>
    app.unsubscribeRoute.getState(typeof token === 'string' ? token : ''),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = unsubscribeGetHandler;
