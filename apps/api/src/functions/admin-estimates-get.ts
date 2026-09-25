/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/estimates/{id}.
 *
 * Read-only estimate lookup for the admin area (admin/03). The route
 * enforces the admin session guard; only GET is bound (AC3 — no mutation
 * path exists).
 *
 * Bundled by `npm run bundle:functions` into `admin-estimates-get/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminEstimates,
  type FunctionContext,
  type FunctionRequest,
} from './admin-estimates/shared';

export async function adminEstimatesGetHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const id = context.bindingData?.['id'];
  await dispatchAdminEstimates(context, req, (app) =>
    app.adminEstimatesRoute.get(
      req.headers ?? {},
      typeof id === 'string' ? id : '',
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminEstimatesGetHandler;
