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

/** Minimal structural types — no @azure/functions dependency needed. */
export interface TimerFunctionContext {
  log: (...args: unknown[]) => void;
}

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

export async function sheetsSyncTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const result = await app.sheetsSyncService.runSyncCycle();
  // Aggregates only — never lead emails, ids, or tokens.
  if (result.disabled) {
    context.log('sheets-sync-timer: Sheets not configured (fail-closed, no sync)');
  } else {
    context.log(
      `sheets-sync-timer: cycle complete (synced=${result.synced} skipped=${result.skipped})`,
    );
  }
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = sheetsSyncTimerHandler;
