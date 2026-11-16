/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/community-narratives/regenerate (#759).
 * Admin-gated, audit-logged "Regenerate now" for one community or all.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-community-narratives-regenerate/index.js`.
 */
import {
  dispatchNarrative,
  type FunctionContext,
  type FunctionRequest,
} from './narrative/shared';

export async function adminCommunityNarrativesRegenerateHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchNarrative(
    context,
    req,
    (app) =>
      app.adminCommunityNarrativesRoute.regenerate(req.headers ?? {}, req.body),
    { path: '/api/v1/admin/community-narratives/regenerate' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminCommunityNarrativesRegenerateHandler;
