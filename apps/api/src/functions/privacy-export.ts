/**
 * Azure Functions v3 trigger adapter — GET /api/v1/privacy/export.
 * Bundled by `npm run bundle:functions` into `privacy-export/index.js`.
 */
import {
  dispatchPrivacy,
  type FunctionContext,
  type FunctionRequest,
} from './privacy/shared';

export async function privacyExportHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchPrivacy(context, req, (app) =>
    app.privacyRoute.exportData(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = privacyExportHandler;
