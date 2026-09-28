/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/estimates/{id}/narrative.
 *
 * Admin-gated narrative generation for support/debugging (fix #287):
 * the admin estimate detail page tops up a missing narrative the same way
 * the consumer report does, but through the admin session guard instead
 * of the magic-link token. Only POST is bound.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-estimates-narrative/index.js` (self-contained — the Function App
 * has no node_modules).
 */
import {
  dispatchAdminEstimates,
  type FunctionContext,
  type FunctionRequest,
} from './admin-estimates/shared';

export async function adminEstimatesNarrativeHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const id = context.bindingData?.['id'];
  await dispatchAdminEstimates(
    context,
    req,
    (app) =>
      app.adminEstimatesRoute.generateNarrative(
        req.headers ?? {},
        typeof id === 'string' ? id : '',
      ),
    { path: '/api/v1/admin/estimates/{id}/narrative' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminEstimatesNarrativeHandler;
