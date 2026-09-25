/**
 * Sheets sync status service (story admin/05).
 *
 * Computes the health of the Sheets auto-sync worker from the append-only
 * `sheets_sync_runs` table:
 *
 * - Healthy: latest finished run succeeded, OR nothing has ever run and
 *   there's nothing to sync (fresh install, no leads yet).
 * - Disabled: Sheets is not configured (`enabled: false`).
 * - Lagging: the last 3 finished runs all failed (mirrors the alert
 *   threshold), or the latest run failed and there are pending leads.
 * - Failing: the latest finished run failed (but not yet at the lagging
 *   threshold).
 *
 * The badge rules match the story:
 * - Healthy — last run succeeded.
 * - Lagging — 3+ consecutive failures (same threshold that fires the
 *   admin/06 alert).
 * - Failing — latest run failed.
 *
 * Also exposes `isRunInFlight()` so the "Sync now" button can be disabled
 * while a run is in progress (the story requires this).
 */
import type {
  SheetsSyncRunRecord,
  SheetsSyncRunStore,
} from './sheets-sync-run.store';

/** Badge shown on the admin status page. */
export type SheetsSyncHealth = 'healthy' | 'lagging' | 'failing' | 'disabled';

export interface SheetsSyncStatus {
  readonly health: SheetsSyncHealth;
  /** ISO timestamp of the latest finished run, or null if none. */
  readonly lastSyncAt: string | null;
  /** Outcome of the latest finished run, or null if none. */
  readonly lastRunStatus: SheetsSyncRunRecord['status'] | null;
  /** Rows synced by the latest finished run. */
  readonly lastRunRowsSynced: number;
  /** Sanitized error from the latest failed run, or null. */
  readonly lastError: string | null;
  /** Leads created but not yet synced. */
  readonly pendingLeads: number;
  /** Lifetime rows synced across all successful runs. */
  readonly totalRowsSynced: number;
  /** True while a run row is open (finished_at = null). */
  readonly runInFlight: boolean;
  /** Recent runs, newest first (for the history table). */
  readonly recentRuns: readonly SheetsSyncRunRecord[];
}

export interface SheetsSyncStatusServiceDeps {
  readonly runs: SheetsSyncRunStore;
  /** From config — mirrors the worker's `enabled` flag. */
  readonly enabled: boolean;
  /** How many recent runs to include (default 10). */
  readonly recentLimit?: number;
  /** Consecutive failures that count as "lagging" (default 3, matches alert). */
  readonly laggingThreshold?: number;
}

export interface SheetsSyncStatusService {
  getStatus(): Promise<SheetsSyncStatus>;
  /** True while a sync run is in flight (button must be disabled). */
  isRunInFlight(): Promise<boolean>;
}

export function createSheetsSyncStatusService(
  deps: SheetsSyncStatusServiceDeps,
): SheetsSyncStatusService {
  const {
    runs,
    enabled,
    recentLimit = 10,
    laggingThreshold = 3,
  } = deps;

  return {
    async getStatus(): Promise<SheetsSyncStatus> {
      const [recent, pendingLeads, totalRowsSynced] = await Promise.all([
        runs.getLatestRuns(recentLimit),
        runs.countPendingLeads(),
        runs.getTotalRowsSynced(),
      ]);

      const runInFlight = recent.some((r) => r.finishedAt === null);
      const finished = recent.filter((r) => r.finishedAt !== null);
      const latest = finished[0] ?? null;

      let health: SheetsSyncHealth;
      if (!enabled) {
        health = 'disabled';
      } else if (!latest) {
        // Never ran. Healthy only when there's nothing waiting.
        health = pendingLeads === 0 ? 'healthy' : 'failing';
      } else if (latest.status === 'success') {
        health = 'healthy';
      } else if (latest.status === 'disabled') {
        health = 'disabled';
      } else {
        // Latest finished run failed — count the consecutive failures.
        let consecutiveFailures = 0;
        for (const run of finished) {
          if (run.status === 'failed') consecutiveFailures++;
          else break;
        }
        health =
          consecutiveFailures >= laggingThreshold ? 'lagging' : 'failing';
      }

      return {
        health,
        lastSyncAt: latest?.finishedAt?.toISOString() ?? null,
        lastRunStatus: latest?.status ?? null,
        lastRunRowsSynced: latest?.rowsSynced ?? 0,
        lastError: latest?.status === 'failed' ? (latest.error ?? null) : null,
        pendingLeads,
        totalRowsSynced,
        runInFlight,
        recentRuns: recent,
      };
    },

    async isRunInFlight(): Promise<boolean> {
      const recent = await runs.getLatestRuns(1);
      return recent.some((r) => r.finishedAt === null);
    },
  };
}
