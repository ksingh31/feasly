/**
 * Thin Sheets sync status route (admin/05). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * `GET /api/v1/admin/ops/sheets-status` — worker health, last run, pending
 * lead count, and recent run history. Numbers only — no PII in the response
 * by construction (error summaries are sanitized by the sync service).
 *
 * `POST /api/v1/admin/ops/sheets-sync-now` — trigger one sync run now.
 * Returns 409 when a run is already in flight (the UI disables the button;
 * the API enforces it). The run is recorded with `trigger='manual'`.
 *
 * Auth: admin only (via `AdminGuard`; interim X-Admin-Key until admin/01
 * lands).
 *
 * Audit note (admin/01 placeholder): when session auth lands, the manual
 * trigger must log the admin's email. Until then the `sheets_sync_runs`
 * row records `trigger='manual'` + timestamp, which is the auditable
 * marker available under the interim key guard.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type {
  SheetsSyncStatus,
  SheetsSyncStatusService,
} from '../services/sheets-sync-status.service';
import type {
  SheetsSyncResult,
  SheetsSyncService,
} from '../services/sheets-sync.service';

export interface SheetsStatusRouteDeps {
  readonly status: SheetsSyncStatusService;
  readonly sync: SheetsSyncService;
  readonly adminGuard: AdminGuard;
}

export interface SheetsStatusRoute {
  /**
   * GET /api/v1/admin/ops/sheets-status
   */
  getStatus(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<SheetsSyncStatus>;
  /**
   * POST /api/v1/admin/ops/sheets-sync-now
   *
   * Triggers one worker run. 409 when a run is already in flight.
   */
  triggerSync(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<SheetsSyncResult>;
}

export function createSheetsStatusRoute(
  deps: SheetsStatusRouteDeps,
): SheetsStatusRoute {
  const { status, sync, adminGuard } = deps;

  return {
    async getStatus(headers): Promise<SheetsSyncStatus> {
      await adminGuard.requireAdmin(headers);
      return status.getStatus();
    },

    async triggerSync(headers): Promise<SheetsSyncResult> {
      await adminGuard.requireAdmin(headers);

      if (await status.isRunInFlight()) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          'A Sheets sync run is already in flight.',
          false,
        );
      }

      // Manual trigger — recorded with trigger='manual' for the audit trail.
      // The sync service never throws for per-lead failures; a Sheets API
      // outage throws and is recorded as a failed run by the service.
      return sync.runSyncCycle('manual');
    },
  };
}
