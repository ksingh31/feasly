/**
 * Azure Functions v3 trigger adapter — POST /api/v1/shares/link/revoke (#838):
 * revoke one of the owner's link shares.
 * Owner report token in the body (never logged); partner tokens → 403.
 *
 * Bundled by `npm run bundle:functions` into `shares-link-revoke/index.js`.
 */
import {
  dispatchShareLink,
  type FunctionContext,
  type FunctionRequest,
} from './shares-link/shared';

export async function sharesLinkRevokeHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchShareLink(context, req, (app) => app.shareRoute.revokeLink(req.body));
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = sharesLinkRevokeHandler;
