/**
 * Azure Functions v3 trigger adapter — GET
 * /api/v1/admin/builders/{id}/export.csv?kind=leads|invoices (#860).
 *
 * The builder's data for hand-over on exit. Admin-gated (AdminGuard inside
 * the route); registry permissions enforced by the dispatcher. Returns
 * `text/csv` with a Content-Disposition attachment header.
 *
 * Bundled by `npm run bundle:functions` into `admin-builders-export/index.js`.
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminBuildersExportHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(
    context,
    req,
    (app) =>
      app.adminBuildersRoute.exportCsv(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.query ?? {},
      ),
    { csv: true, path: '/api/v1/admin/builders/{id}/export.csv' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBuildersExportHandler;
