/**
 * Sheets sync status service (admin/05).
 *
 * Powers `GET /api/v1/admin/ops/sheets-status` and the admin-triggered
 * manual run (`POST /api/v1/admin/ops/sheets-sync-now`). All run state is
 * read from the durable `sheets_sync_runs` table — never process memory —
 * so the panel survives Function App restarts.
 *
 * Badge logic (admin/05 AC2, also documented on the panel):
 * - "failing": consecutive_failures >= 3
 * - "lagging": no successful sync in the last `lagAfterHours` hours (or
 *   runs attempted but never succeeded)
 * - "healthy": otherwise
 */
import type { LeadStore } from './lead.store';
import type {
  SheetsSyncRunStatus,
  SheetsSyncRunStore,
} from './sheets-sync-run.store';
import type { SheetsSyncService } from './sheets-sync.service';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type {
  SheetsSyncNowResponse,
  SheetsSyncStatusResponse,
} from '@feasly/contracts';

export interface SheetsSyncStatusServiceDeps {
  readonly runs: SheetsSyncRunStore;
  readonly leads: Pick<LeadStore, 'countNeverSynced'>;
  readonly sheets: SheetsSyncService;
  /** From config — false = fail-closed, the worker records 'disabled' runs. */
  readonly sheetsConfigured: boolean;
  /** Badge threshold (hours since last success). Default 2 (story AC2). */
  readonly lagAfterHours: number;
  /** A 'running' row older than this is stale, not in flight. */
  readonly runStaleAfterMin: number;
  readonly clock?: () => Date;
}

export interface SheetsSyncStatusService {
  /** Build the ops-panel status payload from durable run history + DB. */
  getStatus(): Promise<SheetsSyncStatusResponse>;
  /**
   * Trigger one manual worker run (audit-logged by the route with the
   * admin's email). Throws 409 CONFLICT when a run is already in flight.
   */
  triggerManualRun(actorEmail: string): Promise<SheetsSyncNowResponse>;
}

/** How many recent runs to scan for failures / last success (bound). */
const RECENT_RUN_SCAN_LIMIT = 50;
/** Failure entries shown on the panel. */
const RECENT_FAILURES_LIMIT = 5;

export function createSheetsSyncStatusService(
  deps: SheetsSyncStatusServiceDeps,
): SheetsSyncStatusService {
  const {
    runs,
    leads,
    sheets,
    sheetsConfigured,
    lagAfterHours,
    runStaleAfterMin,
    clock = () => new Date(),
  } = deps;

  async function inFlight(): Promise<boolean> {
    return (await runs.findInFlight(runStaleAfterMin)) !== null;
  }

  return {
    async getStatus(): Promise<SheetsSyncStatusResponse> {
      const now = clock();
      const [recent, rowsSyncedTotal, pendingCount, flight] =
        await Promise.all([
          runs.recent(RECENT_RUN_SCAN_LIMIT),
          runs.totalSyncedRows(),
          leads.countNeverSynced(),
          inFlight(),
        ]);

      let lastRunAt: Date | null = null;
      let lastSuccessAt: Date | null = null;
      let consecutiveFailures = 0;
      let countingStreak = true;
      const recentFailures: { at: string; error: string }[] = [];

      for (const run of recent) {
        if (!lastRunAt) lastRunAt = run.startedAt;
        if (run.status === 'success' && !lastSuccessAt) {
          lastSuccessAt = run.finishedAt ?? run.startedAt;
        }
        if (countingStreak) {
          if (run.status === 'failed') {
            consecutiveFailures++;
          } else if (run.status !== 'running') {
            // 'success' or 'disabled' breaks the failure streak. A stale
            // 'running' row is skipped — it is neither success nor failure.
            countingStreak = false;
          }
        }
        if (
          run.status === 'failed' &&
          recentFailures.length < RECENT_FAILURES_LIMIT &&
          run.errorMessage
        ) {
          recentFailures.push({
            at: (run.finishedAt ?? run.startedAt).toISOString(),
            error: run.errorMessage,
          });
        }
      }

      // Lagging: failing streak, or no success within the window, or runs
      // attempted but never succeeded. Never ran at all → not lagging
      // (the panel shows a "no runs yet" note instead of a badge alarm).
      const lagging =
        consecutiveFailures >= 3 ||
        (lastSuccessAt !== null &&
          now.getTime() - lastSuccessAt.getTime() >
            lagAfterHours * 3_600_000) ||
        (lastSuccessAt === null && lastRunAt !== null);

      return {
        last_run_at: lastRunAt?.toISOString() ?? null,
        last_success_at: lastSuccessAt?.toISOString() ?? null,
        rows_synced_total: rowsSyncedTotal,
        pending_count: pendingCount,
        consecutive_failures: consecutiveFailures,
        lagging,
        run_in_flight: flight,
        sheets_configured: sheetsConfigured,
        recent_failures: recentFailures,
      };
    },

    async triggerManualRun(actorEmail): Promise<SheetsSyncNowResponse> {
      if (await inFlight()) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          'A Sheets sync run is already in flight. Please wait for it to finish.',
          true,
        );
      }
      const triggeredAt = clock();
      const result = await sheets.runSyncCycle({
        trigger: 'manual',
        actorEmail,
      });
      return {
        synced: result.synced,
        skipped: result.skipped,
        disabled: result.disabled,
        triggered_at: triggeredAt.toISOString(),
      };
    },
  };
}

/** Re-exported for tests that assert the streak scan skips stale runs. */
export type { SheetsSyncRunStatus };
