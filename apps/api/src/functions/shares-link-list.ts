/**
 * Azure Functions v3 trigger adapter — POST /api/v1/shares/link/list (#838):
 * list the owner's link shares with status.
 * Owner report token in the body (never logged); partner tokens → 403.
 *
 * Bundled by `npm run bundle:functions` into `shares-link-list/index.js`.
 */
import {
  dispatchShareLink,
  type FunctionContext,
  type FunctionRequest,
} from './shares-link/shared';

export async function sharesLinkListHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchShareLink(context, req, (app) => app.shareRoute.listLinks(req.body));
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = sharesLinkListHandler;
