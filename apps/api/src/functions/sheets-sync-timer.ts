/**
 * Azure Functions v3 timer-trigger adapter — hourly Sheets sync (admin/04).
 *
 * Schedule (function.json): `0 0 * * * *` — top of every hour, UTC.
 * Runs the Sheets sync service's cycle: upserts new/updated leads to
 * Karan's Google Sheet. Postgres is the source of truth — the worker
 * never writes to `leads` except the `sheets_synced_at` watermark.
 *
 * Fail-closed: if the Sheet ID or service-account email is unconfigured,
 * the worker does nothing (the service reports `disabled: true`).
 *
 * No PII is logged — only aggregate counts (synced / skipped / disabled).
 *
 * Bundled by `npm run bundle:functions` into `sheets-sync-timer/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import { createComposition, type AppComposition } from '../index';
import { sanitizeErrorMessage } from '../lib/sanitize-error';
import type { SheetsSyncResult } from '../services/sheets-sync.service';

/** Minimal structural types — no @azure/functions dependency needed. */
export interface TimerFunctionContext {
  log: (...args: unknown[]) => void;
}

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

/**
 * The timer's work, extracted for testability. Takes the composition (or a
 * test double with the same `sheetsSyncService`) so the adapter test can
 * run the real service against a real database without the Azure host.
 *
 * This is the exact code path that failed silently on Azure in Sep 2026:
 * the run-record INSERT into `sheets_sync_runs` threw (dev schema drift),
 * so the whole invocation died before doing anything. The adapter test
 * pins this path against PGlite with the real migrations applied.
 */
export async function runSheetsSyncTimer(
  app: Pick<AppComposition, 'sheetsSyncService'>,
  context: TimerFunctionContext,
): Promise<void> {
  let result: SheetsSyncResult;
  try {
    result = await app.sheetsSyncService.runSyncCycle({
      trigger: 'timer',
    });
  } catch (error) {
    // Structured failure line: if the cycle dies before recording a run
    // (e.g. the `sheets_sync_runs` INSERT itself fails — the Sep 2026
    // incident), the ops panel and the lagging metric never see it, so this
    // log line is the backstop Azure Monitor can alert on. Rethrown so the
    // host still records the invocation failure and retries on schedule.
    // The message is sanitized — never credentials, never PII.
    context.log(
      `sheets-sync-timer: CYCLE FAILED (error=${sanitizeErrorMessage(error)})`,
    );
    throw error;
  }
  // Aggregates only — never lead emails, ids, or tokens.
  // The `lagging` flag is the `sheets_sync.lagging` metric (AC4): a
  // structured log line lets Azure Monitor pick it up, and admin/05's
  // status view reads the same flag from `sheets_sync_state`.
  if (result.disabled) {
    context.log('sheets-sync-timer: Sheets not configured (fail-closed, no sync)');
  } else {
    context.log(
      `sheets-sync-timer: cycle complete (synced=${result.synced} skipped=${result.skipped} consecutiveFailures=${result.consecutiveFailures} lagging=${result.lagging})`,
    );
  }
}

/**
 * Azure Functions v3 programming model entry point: builds (once) and
 * reuses the real composition, then runs one timer cycle.
 */
export async function sheetsSyncTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  await runSheetsSyncTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = sheetsSyncTimerHandler;
