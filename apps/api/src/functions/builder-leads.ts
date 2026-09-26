/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/leads.
 *
 * Tenant-scoped lead list for the builder portal. Requires a valid builder
 * session; the guard provides the tenant_key.
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

export async function builderLeadsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderLeads(context, req, (app) =>
    app.builderLeadsRoute.list(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderLeadsHandler;
