/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/leads/needs-you.
 *
 * Leads home "Needs you" groups + status counts (issue #526). Requires a
 * valid builder session; the guard provides the tenant_key and the
 * registry permissions (builder:leads:read) are enforced centrally.
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

export async function builderLeadsNeedsYouHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderLeads(context, req, (app) =>
    app.builderLeadsRoute.needsYou(req.headers ?? {}),
    { path: '/api/v1/builder/leads/needs-you' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderLeadsNeedsYouHandler;
