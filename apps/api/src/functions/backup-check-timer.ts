/**
 * Azure Functions v3 timer-trigger adapter — daily Postgres backup freshness
 * check (admin/06, `backup_missed` alert class).
 *
 * Schedule (function.json): `0 0 6 * * *` — 06:00 UTC daily.
 * Queries the flexible server's backup config through ARM using the Function
 * App's system-assigned managed identity (platform identity endpoint, IMDS
 * fallback — no secrets). On a stale/missing backup chain it fires
 * `notifyFailure('backup_missed', …)` — deduplicated to one email per 24h
 * by the ops-alerts service — and on recovery it sends the all-clear via
 * `notifyRecovered('backup_missed')`.
 *
 * Fail-closed: when BACKUP_CHECK_ENABLED is not 'true' (or the server
 * details are unconfigured) the timer logs and does nothing. When the
 * probe itself errors (`probeError` — token acquisition or ARM query
 * failed), it logs a structured `PROBE FAILED` line and skips — no
 * `backup_missed` alert fires on a broken probe (CI's backup-config job
 * remains the backstop for the probe). A throw anywhere else is logged as
 * `CYCLE FAILED` and rethrown so the host records the invocation failure.
 *
 * No PII is logged — only aggregates (retention days, stale hours).
 *
 * Bundled by `npm run bundle:functions` into `backup-check-timer/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import { createComposition, type AppComposition } from '../index';
import { sanitizeErrorMessage } from '../lib/sanitize-error';
import type { BackupCheckService } from '../services/backup-check.service';
import type { OpsAlertsService } from '../services/ops-alerts.service';

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
 * test double with the same services) so the adapter test can pin the
 * wiring without the Azure host.
 */
export async function runBackupCheckTimer(
  app: Pick<AppComposition, 'backupCheckService' | 'opsAlertsService'>,
  context: TimerFunctionContext,
): Promise<void> {
  const check: BackupCheckService | undefined = app.backupCheckService;
  if (!check) {
    context.log('backup-check-timer: backup check not configured (fail-closed, no check)');
    return;
  }
  let freshness;
  try {
    freshness = await check.checkBackupFreshness();
  } catch (error) {
    // The service is designed to return results instead of throwing, but a
    // bug must never kill the timer silently: structured failure line for
    // Azure Monitor, rethrown so the host records the invocation failure.
    context.log(
      `backup-check-timer: CYCLE FAILED (error=${sanitizeErrorMessage(error)})`,
    );
    throw error;
  }
  if (freshness.probeError) {
    // The check itself could not run (managed-identity token or ARM query
    // failed) — that is not a backup-health signal, so no `backup_missed`
    // alert fires. Structured line for Azure Monitor alerting (see
    // infra/bicep/modules/alerts.bicep `backup-check-probe` rule).
    context.log(
      `backup-check-timer: PROBE FAILED (reason=${freshness.reason ?? 'unknown'})`,
    );
    return;
  }
  const opsAlerts: OpsAlertsService = app.opsAlertsService;
  if (freshness.healthy) {
    await opsAlerts.notifyRecovered('backup_missed');
    context.log(
      `backup-check-timer: backup chain healthy ` +
        `(retentionDays=${freshness.retentionDays} ` +
        `staleHours=${freshness.staleHours?.toFixed(1) ?? 'n/a'})`,
    );
    return;
  }
  await opsAlerts.notifyFailure('backup_missed', {
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

/**
 * Azure Functions v3 programming model entry point: builds (once) and
 * reuses the real composition, then runs one timer cycle.
 */
export async function backupCheckTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  await runBackupCheckTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = backupCheckTimerHandler;
