/**
 * Azure Functions v3 trigger adapter — POST /api/v1/shares/link (#838):
 * mint a read-only, expiring report link to copy.
 * Owner report token in the body (never logged); partner tokens → 403.
 *
 * Bundled by `npm run bundle:functions` into `shares-link/index.js`.
 */
import {
  dispatchShareLink,
  type FunctionContext,
  type FunctionRequest,
} from './shares-link/shared';

export async function sharesLinkHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchShareLink(context, req, (app) => app.shareRoute.createLink(req.body));
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = sharesLinkHandler;
