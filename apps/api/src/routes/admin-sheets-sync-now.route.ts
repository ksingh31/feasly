/**
 * Thin admin Sheets-sync manual-trigger route (admin/05).
 * Routes are adapters, not logic: enforce the admin guard → call exactly
 * one service method → audit-log the attempt → return the result.
 *
 * - POST /api/v1/admin/ops/sheets-sync-now — admin-gated. Triggers one
 *   worker run inline and records the attempt in `admin_audit_log` with the
 *   triggering admin's email. Returns 409 CONFLICT when a run is already
 *   in flight (the panel disables the button via `run_in_flight`).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { SheetsSyncNowResponse } from '@feasly/contracts';
import type { AdminGuard } from '../middleware/admin-guard';
import type { AdminAuditStore } from '../services/admin-audit.store';
import type { SheetsSyncStatusService } from '../services/sheets-sync-status.service';

export interface AdminSheetsSyncNowRouteDeps {
  readonly status: SheetsSyncStatusService;
  readonly audit: AdminAuditStore;
  readonly adminGuard: AdminGuard;
}

export interface AdminSheetsSyncNowRoute {
  /** POST /api/v1/admin/ops/sheets-sync-now */
  trigger(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<SheetsSyncNowResponse>;
}

/** Machine-readable action recorded in admin_audit_log. */
export const MANUAL_SHEETS_SYNC_AUDIT_ACTION = 'sheets_sync_manual';

export function createAdminSheetsSyncNowRoute(
  deps: AdminSheetsSyncNowRouteDeps,
): AdminSheetsSyncNowRoute {
  const { status, audit, adminGuard } = deps;

  async function auditAttempt(
    actorEmail: string,
    detail: string,
  ): Promise<void> {
    try {
      await audit.append({
        action: MANUAL_SHEETS_SYNC_AUDIT_ACTION,
        actorEmail,
        detail,
      });
    } catch (auditError) {
      // Audit is best-effort: never mask the sync outcome.
      console.error('sheets-sync-now: audit append failed', auditError);
    }
  }

  return {
    async trigger(headers): Promise<SheetsSyncNowResponse> {
      await adminGuard.requireAdmin(headers);
      const actorEmail =
        (await adminGuard.getAdminEmail(headers)) ?? 'unknown';
      try {
        const result = await status.triggerManualRun(actorEmail);
        await auditAttempt(
          actorEmail,
          `ok synced=${result.synced} skipped=${result.skipped} ` +
            `disabled=${result.disabled}`,
        );
        return result;
      } catch (error) {
        await auditAttempt(
          actorEmail,
          `error ${error instanceof Error ? error.constructor.name : 'UnknownError'}`,
        );
        throw error;
      }
    },
  };
}
