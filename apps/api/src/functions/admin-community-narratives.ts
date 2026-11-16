/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/community-narratives
 * (#759). Admin-gated status list. Reuses the narrative adapter dispatch
 * (CORS at the edge, cached composition, registry permissions, RFC 7807).
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-community-narratives/index.js`.
 */
import {
  dispatchNarrative,
  type FunctionContext,
  type FunctionRequest,
} from './narrative/shared';

export async function adminCommunityNarrativesHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchNarrative(
    context,
    req,
    (app) => app.adminCommunityNarrativesRoute.list(req.headers ?? {}),
    { path: '/api/v1/admin/community-narratives' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminCommunityNarrativesHandler;
