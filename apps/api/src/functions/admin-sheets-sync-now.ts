/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/ops/sheets-sync-now.
 *
 * Triggers exactly one Sheets sync worker run inline and audit-logs the
 * attempt with the triggering admin's email (inside the route).
 * Returns 409 CONFLICT when a run is already in flight.
 *
 * Bundled by `npm run bundle:functions` into `admin-sheets-sync-now/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminSheets,
  type FunctionContext,
  type FunctionRequest,
} from './admin-sheets/shared';

export async function adminSheetsSyncNowHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminSheets(context, req, (app) =>
    app.adminSheetsSyncNowRoute.trigger(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminSheetsSyncNowHandler;
