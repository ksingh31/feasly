/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/ops/sheets-status.
 *
 * Sheets sync worker health at a glance: last run/success, rows synced,
 * pending count, consecutive failures, lagging flag, in-flight state.
 * Admin-gated via the session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-sheets-status/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminSheets,
  type FunctionContext,
  type FunctionRequest,
} from './admin-sheets/shared';

export async function adminSheetsStatusHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminSheets(context, req, (app) =>
    app.adminSheetsStatusRoute.getStatus(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminSheetsStatusHandler;
