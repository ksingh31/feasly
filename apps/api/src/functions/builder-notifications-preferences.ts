/**
 * Azure Functions v3 trigger adapter — GET + PUT
 * /api/v1/builder/notifications/preferences (#725).
 *
 * The signed-in builder member reads (GET) or changes (PUT) their email
 * preferences: new-lead email, daily "Needs you" digest, billing email.
 * Builder session required; registry permissions (builder:leads:read)
 * enforced centrally by the shared dispatcher.
 */
import {
  dispatchBuilderLeads,
  type FunctionContext,
  type FunctionRequest,
} from './builder-leads/shared';

const PATH = '/api/v1/builder/notifications/preferences';

export async function builderNotificationsPreferencesHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'PUT') {
    await dispatchBuilderLeads(
      context,
      req,
      (app) => app.builderNotificationsRoute.updatePreferences(req.headers ?? {}, req.body),
      { path: PATH },
    );
    return;
  }
  await dispatchBuilderLeads(
    context,
    req,
    (app) => app.builderNotificationsRoute.getPreferences(req.headers ?? {}),
    { path: PATH },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderNotificationsPreferencesHandler;
