/**
 * Azure Functions v3 timer-trigger adapter — daily sandbox purge (api-mcp/09).
 *
 * Schedule (function.json): `0 0 2 * * *` — daily at 02:00 UTC.
 * Runs the sandbox purge service: hard-deletes sandbox test rows older
 * than the retention window (default 30 days) across leads, estimates,
 * magic_links, and analytics_events.
 *
 * The first run executes in dry-run mode (config flag
 * `SANDBOX_PURGE_DRY_RUN`, default true): counts are computed and logged
 * but nothing is deleted.
 *
 * No PII is logged — only per-table aggregate counts and the dry-run flag.
 *
 * Bundled by `npm run bundle:functions` into `sandbox-purge-timer/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import { createComposition, type AppComposition } from '../index';
import { formatPurgeLogLine } from '../services/sandbox-purge.service';

/** Minimal structural types — no @azure/functions dependency needed. */
export interface TimerFunctionContext {
  log: (...args: unknown[]) => void;
}

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

export async function sandboxPurgeTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const result = await app.sandboxPurgeService.runPurge();
  // Aggregates only — never emails, ids, or tokens.
  context.log(formatPurgeLogLine(result));
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = sandboxPurgeTimerHandler;
