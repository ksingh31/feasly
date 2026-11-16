/**
 * Azure Functions v3 trigger adapter — GET
 * /api/v1/admin/builders/{id}/offboarding-blockers (#861).
 *
 * What blocks "complete offboarding" right now (unpaid invoices, open
 * disputes) — the admin drawer's offboarding checklist. Admin-gated
 * (AdminGuard inside the route); registry permissions (`builders:manage`)
 * enforced by the dispatcher.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-builders-offboarding-blockers/index.js`.
 */
import {
  dispatchAdminBuilders,
  type FunctionContext,
  type FunctionRequest,
} from './admin-builders/shared';

export async function adminBuildersOffboardingBlockersHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBuilders(
    context,
    req,
    (app) =>
      app.adminBuildersRoute.offboardingBlockers(
        req.headers ?? {},
        context.bindingData?.['id'],
      ),
    { path: '/api/v1/admin/builders/{id}/offboarding-blockers' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBuildersOffboardingBlockersHandler;
