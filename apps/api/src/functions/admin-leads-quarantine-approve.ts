/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/leads/{id}/quarantine/approve.
 *
 * Clears the quarantine/honeypot flag (audit-logged); the lead returns to
 * the normal pipeline. Admin-gated via the session-cookie AdminGuard
 * (inside the route).
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-leads-quarantine-approve/index.js`.
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminLeadsQuarantineApproveHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(context, req, (app) =>
    app.adminLeadsRoute.approveQuarantine(
      req.headers ?? {},
      context.bindingData?.['id'],
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadsQuarantineApproveHandler;
