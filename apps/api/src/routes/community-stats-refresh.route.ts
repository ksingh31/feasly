/**
 * Thin admin community-stats refresh route (neighbourhood/05).
 * Routes are adapters, not logic: enforce the admin guard → call exactly
 * one service method → audit-log the attempt → return the result.
 *
 * - POST /api/v1/admin/community-stats/refresh — admin-gated (the
 *   `AdminGuard` interface — currently the interim pre-shared-key guard;
 *   admin/01 swaps in session auth without touching this route). Triggers
 *   one refresh cycle on demand for ops (e.g. after fixing a Socrata
 *   outage) and records the attempt in `admin_audit_log`.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { AdminGuard } from '../middleware/admin-guard';
import type { AdminAuditStore } from '../services/admin-audit.store';
import type { CommunityStatsRefreshService } from '../services/community-stats-refresh.service';

export interface CommunityStatsRefreshRouteDeps {
  readonly refresh: CommunityStatsRefreshService;
  readonly audit: AdminAuditStore;
  readonly adminGuard: AdminGuard;
}

/** Serialized response — snake_case, counts only (no community data). */
export interface ManualRefreshResponse {
  readonly refreshed: number;
  readonly skipped: number;
  readonly roll_year: string;
  readonly refreshed_at: string;
}

export interface CommunityStatsRefreshRoute {
  /** POST /api/v1/admin/community-stats/refresh */
  trigger(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<ManualRefreshResponse>;
}

/** Machine-readable action recorded in admin_audit_log. */
export const MANUAL_REFRESH_AUDIT_ACTION = 'community_stats_refresh_manual';

export function createCommunityStatsRefreshRoute(
  deps: CommunityStatsRefreshRouteDeps,
): CommunityStatsRefreshRoute {
  const { refresh, audit, adminGuard } = deps;

  async function auditAttempt(detail: string): Promise<void> {
    try {
      await audit.append({
        action: MANUAL_REFRESH_AUDIT_ACTION,
        actorEmail: 'admin',
        detail,
      });
    } catch (auditError) {
      // Audit is best-effort: never mask the refresh outcome.
      console.error('community-stats-refresh: audit append failed', auditError);
    }
  }

  return {
    async trigger(headers): Promise<ManualRefreshResponse> {
      await adminGuard.requireAdmin(headers);
      try {
        const result = await refresh.runRefreshCycle();
        await auditAttempt(
          `ok refreshed=${result.refreshed} skipped=${result.skipped} ` +
            `roll_year=${result.rollYear}`,
        );
        return {
          refreshed: result.refreshed,
          skipped: result.skipped,
          roll_year: result.rollYear,
          refreshed_at: result.refreshedAt.toISOString(),
        };
      } catch (error) {
        await auditAttempt(
          `error ${error instanceof Error ? error.constructor.name : 'UnknownError'}`,
        );
        throw error;
      }
    },
  };
}
