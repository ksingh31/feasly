/**
 * Azure Functions v3 trigger adapter — PATCH /api/v1/builder/leads/{id}.
 *
 * Pipeline status transition for a builder's lead. Requires a valid
 * builder session; the lead must belong to the builder's tenant (403
 * otherwise).
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

export async function builderLeadsStatusHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderLeads(context, req, (app) =>
    app.builderLeadsRoute.updateStatus(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderLeadsStatusHandler;
