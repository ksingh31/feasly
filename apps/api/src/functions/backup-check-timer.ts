/**
 * Azure Functions v3 timer-trigger adapter — daily Postgres backup freshness
 * check (admin/06, `backup_missed` alert class).
 *
 * Schedule (function.json): `0 0 6 * * *` — 06:00 UTC daily.
 * Queries the flexible server's backup config through ARM using the Function
 * App's system-assigned managed identity (no secrets). On a stale/missing
 * backup chain it fires `notifyFailure('backup_missed', …)` — deduplicated
 * to one email per 24h by the ops-alerts service — and on recovery it sends
 * the all-clear via `notifyRecovered('backup_missed')`.
 *
 * Fail-closed: when BACKUP_CHECK_ENABLED is not 'true' (or the server
 * details are unconfigured) the timer logs and does nothing. When the ARM
 * check itself errors, it logs and skips — no alert fires on a broken
 * probe (CI's backup-config job remains the backstop for the probe).
 *
 * No PII is logged — only aggregates (retention days, stale hours).
 *
 * Bundled by `npm run bundle:functions` into `backup-check-timer/index.js`
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

export async function backupCheckTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const check = app.backupCheckService;
  if (!check) {
    context.log('backup-check-timer: backup check not configured (fail-closed, no check)');
    return;
  }
  let freshness;
  try {
    freshness = await check.checkBackupFreshness();
  } catch (error) {
    // The service is designed to return unhealthy results instead of
    // throwing, but a bug must never kill the timer host.
    context.log(
      `backup-check-timer: probe errored, skipping (${(error as Error).message})`,
    );
    return;
  }
  if (freshness.healthy) {
    await app.opsAlertsService.notifyRecovered('backup_missed');
    context.log(
      `backup-check-timer: backup chain healthy ` +
        `(retentionDays=${freshness.retentionDays} ` +
        `staleHours=${freshness.staleHours?.toFixed(1) ?? 'n/a'})`,
    );
    return;
  }
  await app.opsAlertsService.notifyFailure('backup_missed', {
    consecutiveFailures: 1,
    firstFailureAt: freshness.staleSince ?? new Date(),
  });
  // Aggregates only — never tokens, connection strings, or principal ids.
  context.log(
    `backup-check-timer: BACKUP STALE (${freshness.reason}; ` +
      `retentionDays=${freshness.retentionDays ?? 'n/a'} ` +
      `staleHours=${freshness.staleHours?.toFixed(1) ?? 'n/a'})`,
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = backupCheckTimerHandler;
