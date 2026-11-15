/**
 * Azure Functions v3 trigger adapter — POST /api/v1/builder/leads/{id}/mark-won.
 *
 * Issue #530: any org member marks a lead won without recording the
 * contract. The lead then shows as "Needs recording" and the org's admins
 * are emailed to record the signed contract. Requires a valid builder
 * session; the lead must belong to the builder's tenant (403 otherwise).
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

export async function builderLeadsMarkWonHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderLeads(context, req, (app) =>
    app.builderLeadsRoute.markWon(
      req.headers ?? {},
      context.bindingData?.['id'],
    ),
    { path: '/api/v1/builder/leads/{id}/mark-won' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderLeadsMarkWonHandler;
