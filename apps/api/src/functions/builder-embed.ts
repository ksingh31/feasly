/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/embed (#870).
 *
 * The builder's install snippet, allowed origins (read-only) and the
 * per-origin install check. Builder session required; registry
 * permissions enforced centrally by the shared dispatcher.
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

export async function builderEmbedHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderLeads(
    context,
    req,
    (app) => app.builderSettingsRoute.getEmbed(req.headers ?? {}),
    { path: '/api/v1/builder/embed' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderEmbedHandler;
