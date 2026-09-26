/**
 * Thin admin calibration route (admin/09). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - `GET /api/v1/admin/calibration` — calibration console payload
 *   (current version, report, import history).
 *
 * Read-only by design: no write endpoints exist on this page. Param
 * changes go through the freeze process (cost-engine/01), never through
 * the console (AC2).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { AdminCalibrationResponse } from '@feasly/contracts';
import type { AdminGuard } from '../middleware/admin-guard';
import type { AdminCalibrationService } from '../services/admin-calibration.service';

export interface AdminCalibrationRouteDeps {
  readonly adminCalibration: AdminCalibrationService;
  readonly adminGuard: AdminGuard;
}

export interface AdminCalibrationRoute {
  /** GET /api/v1/admin/calibration */
  get(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AdminCalibrationResponse>;
}

export function createAdminCalibrationRoute(
  deps: AdminCalibrationRouteDeps,
): AdminCalibrationRoute {
  const { adminCalibration, adminGuard } = deps;

  return {
    async get(headers): Promise<AdminCalibrationResponse> {
      await adminGuard.requireAdmin(headers);
      const email = await adminGuard.getAdminEmail(headers);
      return adminCalibration.getCalibration(email ?? 'admin@session');
    },
  };
}
