/**
 * Azure Functions v3 trigger adapter — GET + PUT /api/v1/builder/profile
 * (#870).
 *
 * Any org member reads the profile & branding (GET); org owners change it
 * (PUT, `builder:settings:manage`). Builder session required; registry
 * permissions enforced centrally by the shared dispatcher.
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

const PATH = '/api/v1/builder/profile';

export async function builderProfileHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'PUT') {
    await dispatchBuilderLeads(
      context,
      req,
      (app) => app.builderSettingsRoute.updateProfile(req.headers ?? {}, req.body),
      { path: PATH },
    );
    return;
  }
  await dispatchBuilderLeads(
    context,
    req,
    (app) => app.builderSettingsRoute.getProfile(req.headers ?? {}),
    { path: PATH },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderProfileHandler;
