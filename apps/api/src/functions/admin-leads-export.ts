/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/leads/export.csv.
 *
 * CSV export of the filtered lead set. Admin-gated via the session-cookie
 * AdminGuard (inside the route). Returns `text/csv` with a
 * Content-Disposition attachment header.
 *
 * Bundled by `npm run bundle:functions` into `admin-leads-export/index.js`.
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminLeadsExportHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(
    context,
    req,
    (app) => app.adminLeadsRoute.exportCsv(req.headers ?? {}, req.query ?? {}),
    { csv: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadsExportHandler;
