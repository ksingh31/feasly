/**
 * Azure Functions v3 trigger adapter — POST
 * /api/v1/builder/embed/origin-requests (#870).
 *
 * An org owner asks Feasly staff to add/remove allowed embed origins
 * (staff-controlled for the pilot). Creates one admin task and emails the
 * team inbox. Builder session required; registry permissions
 * (`builder:settings:manage`) enforced centrally by the shared dispatcher.
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

export async function builderEmbedOriginRequestsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderLeads(
    context,
    req,
    (app) =>
      app.builderSettingsRoute.requestOriginChange(req.headers ?? {}, req.body),
    { path: '/api/v1/builder/embed/origin-requests' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderEmbedOriginRequestsHandler;
