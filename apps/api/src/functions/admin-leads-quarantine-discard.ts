/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/leads/{id}/quarantine/discard.
 *
 * Marks the lead discarded (kept for audit, excluded from lists/counts;
 * audit-logged). Admin-gated via the session-cookie AdminGuard (inside
 * the route).
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-leads-quarantine-discard/index.js`.
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminLeadsQuarantineDiscardHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(context, req, (app) =>
    app.adminLeadsRoute.discardQuarantine(
      req.headers ?? {},
      context.bindingData?.['id'],
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadsQuarantineDiscardHandler;
