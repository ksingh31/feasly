/**
 * Azure Functions v3 trigger adapter — POST
 * /api/v1/builder/account/close-request (#860).
 *
 * An org owner asks Feasly to close the builder account: one admin task +
 * team-inbox email. Builder session required; registry permissions
 * (`builder:settings:manage`) enforced centrally by the shared dispatcher.
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

export async function builderAccountCloseRequestHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderLeads(
    context,
    req,
    (app) =>
      app.builderSettingsRoute.requestAccountClosure(req.headers ?? {}, req.body),
    { path: '/api/v1/builder/account/close-request' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAccountCloseRequestHandler;
