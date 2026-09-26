/**
 * Thin admin Sheets-sync status route (admin/05).
 * Routes are adapters, not logic: enforce the admin guard → call exactly
 * one service method → return the result.
 *
 * - GET /api/v1/admin/ops/sheets-status — admin-gated. Returns the durable
 *   worker run state (last run/success, rows synced, pending count,
 *   consecutive failures, lagging flag) for the ops panel.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { SheetsSyncStatusResponse } from '@feasly/contracts';
import type { AdminGuard } from '../middleware/admin-guard';
import type { SheetsSyncStatusService } from '../services/sheets-sync-status.service';

export interface AdminSheetsStatusRouteDeps {
  readonly status: SheetsSyncStatusService;
  readonly adminGuard: AdminGuard;
}

export interface AdminSheetsStatusRoute {
  /** GET /api/v1/admin/ops/sheets-status */
  getStatus(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<SheetsSyncStatusResponse>;
}

export function createAdminSheetsStatusRoute(
  deps: AdminSheetsStatusRouteDeps,
): AdminSheetsStatusRoute {
  const { status, adminGuard } = deps;

  return {
    async getStatus(headers): Promise<SheetsSyncStatusResponse> {
      await adminGuard.requireAdmin(headers);
      return status.getStatus();
    },
  };
}
