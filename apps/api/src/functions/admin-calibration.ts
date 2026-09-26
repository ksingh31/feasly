/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/calibration.
 *
 * Calibration console payload (admin/09): current cost-data version,
 * calibration report, import history. Read-only by design.
 * Admin-gated via the session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-calibration/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminCalibration,
  type FunctionContext,
  type FunctionRequest,
} from './admin-calibration/shared';

export async function adminCalibrationHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminCalibration(context, req, (app) =>
    app.adminCalibrationRoute.get(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminCalibrationHandler;
