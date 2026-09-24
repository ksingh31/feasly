/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/privacy/erase-requests/{requestId}/confirm.
 * Bundled by `npm run bundle:functions` into `privacy-erase-confirm/index.js`.
 */
import {
  dispatchPrivacy,
  type FunctionContext,
  type FunctionRequest,
} from './privacy/shared';

export async function privacyEraseConfirmHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const requestId = context.bindingData?.['requestId'];
  await dispatchPrivacy(context, req, (app) =>
    app.privacyRoute.confirmErasure(
      req.headers ?? {},
      typeof requestId === 'string' ? requestId : '',
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = privacyEraseConfirmHandler;
