/**
 * Thin admin neighbourhood-data route (#773).
 * Routes are adapters, not logic: admin guard → validate the provider →
 * call exactly one service method → audit-log the attempt → return counts.
 *
 * - POST /api/v1/admin/neighbourhood-data/{provider}/refresh — runs one
 *   provider's refresh now (e.g. after fixing a source outage). Every
 *   attempt is recorded in `admin_audit_log` with the admin's email.
 *
 * Hard rules (enforced by test/boundaries.test.ts): no db/, no process.env,
 * depends on service interfaces only.
 */
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { AdminAuditStore } from '../services/admin-audit.store';
import { isNeighbourhoodProviderName } from '../services/neighbourhood-data/providers';
import type { NeighbourhoodRefreshService } from '../services/neighbourhood-data/neighbourhood-refresh.service';

export interface AdminNeighbourhoodDataRouteDeps {
  readonly refresh: NeighbourhoodRefreshService;
  readonly audit: AdminAuditStore;
  readonly adminGuard: AdminGuard;
}

/** Serialized response — snake_case, counts only. */
export interface NeighbourhoodRefreshResponse {
  readonly provider: string;
  readonly implementation: string;
  readonly outcome: 'ok' | 'failed' | 'skipped';
  readonly rows_changed: number;
  readonly rows_pruned: number;
  readonly rows_total: number;
  readonly consecutive_failures: number;
  readonly error: string | null;
}

export interface AdminNeighbourhoodDataRoute {
  /** POST /api/v1/admin/neighbourhood-data/{provider}/refresh */
  refresh(
    headers: Record<string, string | string[] | undefined>,
    provider: unknown,
  ): Promise<NeighbourhoodRefreshResponse>;
}

/** Machine-readable action recorded in admin_audit_log. */
export const NEIGHBOURHOOD_REFRESH_AUDIT_ACTION = 'neighbourhood_data_refresh_manual';

export function createAdminNeighbourhoodDataRoute(
  deps: AdminNeighbourhoodDataRouteDeps,
): AdminNeighbourhoodDataRoute {
  const { refresh, audit, adminGuard } = deps;

  async function auditAttempt(actorEmail: string, detail: string): Promise<void> {
    try {
      await audit.append({ action: NEIGHBOURHOOD_REFRESH_AUDIT_ACTION, actorEmail, detail });
    } catch (auditError) {
      // Audit is best-effort: never mask the refresh outcome.
      console.error('neighbourhood-data-refresh: audit append failed', auditError);
    }
  }

  return {
    async refresh(headers, provider): Promise<NeighbourhoodRefreshResponse> {
      await adminGuard.requireAdmin(headers);
      const actorEmail = (await adminGuard.getAdminEmail(headers)) ?? 'admin@session';
      if (!isNeighbourhoodProviderName(provider)) {
        throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Unknown neighbourhood data provider.', false);
      }
      try {
        const result = await refresh.refreshNow(provider);
        await auditAttempt(
          actorEmail,
          `provider=${provider} impl=${result.implementation} outcome=${result.outcome} ` +
            `changed=${result.rowsChanged} pruned=${result.rowsPruned}`,
        );
        return {
          provider: result.provider,
          implementation: result.implementation,
          outcome: result.outcome,
          rows_changed: result.rowsChanged,
          rows_pruned: result.rowsPruned,
          rows_total: result.rowsTotal,
          consecutive_failures: result.consecutiveFailures,
          error: result.error ?? null,
        };
      } catch (error) {
        await auditAttempt(
          actorEmail,
          `provider=${provider} error=${error instanceof Error ? error.constructor.name : 'UnknownError'}`,
        );
        throw error;
      }
    },
  };
}
