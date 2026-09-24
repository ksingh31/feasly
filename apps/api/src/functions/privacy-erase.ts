/**
 * Azure Functions v3 trigger adapter — POST /api/v1/privacy/erase-requests.
 * Bundled by `npm run bundle:functions` into `privacy-erase/index.js`.
 */
import {
  dispatchPrivacy,
  type FunctionContext,
  type FunctionRequest,
} from './privacy/shared';

export async function privacyEraseHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchPrivacy(context, req, (app) =>
    app.privacyRoute.requestErasure(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = privacyEraseHandler;
