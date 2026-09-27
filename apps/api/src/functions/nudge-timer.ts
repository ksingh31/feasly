/**
 * Azure Functions v3 timer-trigger adapter — hourly 24h nudge (email/02).
 *
 * Schedule (function.json): `0 0 * * * *` — top of every hour, UTC.
 * Runs the nudge service's cycle: one polite reminder per unverified lead
 * created ~24h ago. The service itself enforces exactly-once
 * (`nudge_sent_at`), skips verified/opted-out/quarantined leads, and never
 * lets one bad lead kill the batch.
 *
 * No PII is logged — only aggregate counts (nudged / skipped).
 *
 * Bundled by `npm run bundle:functions` into `nudge-timer/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import { createComposition, type AppComposition } from '../index';
import { sanitizeErrorMessage } from '../lib/sanitize-error';

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
 * test double with the same `nudgeService`) so the adapter test can pin
 * the failure path without the Azure host.
 *
 * This is the same silent-failure class PR #217 fixed on sheets-sync-timer:
 * if the cycle itself throws (e.g. the candidate SELECT dies on schema
 * drift), the per-lead batch catch never runs and the hourly aggregate
 * line never prints — the failure was visible only in App Insights. The
 * structured CYCLE FAILED line is the backstop Azure Monitor can alert on.
 * Rethrown so the host still records the invocation failure and retries
 * on schedule.
 */
export async function runNudgeTimer(
  app: Pick<AppComposition, 'nudgeService'>,
  context: TimerFunctionContext,
): Promise<void> {
  let nudged: number;
  let skipped: number;
  try {
    ({ nudged, skipped } = await app.nudgeService.runNudgeCycle());
  } catch (error) {
    // Sanitized — never credentials, never PII (no emails, ids, tokens).
    context.log(
      `nudge-timer: CYCLE FAILED (error=${sanitizeErrorMessage(error)})`,
    );
    throw error;
  }
  // Aggregates only — never lead emails, ids, or tokens.
  context.log(`nudge-timer: cycle complete (nudged=${nudged} skipped=${skipped})`);
}

export async function nudgeTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  await runNudgeTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = nudgeTimerHandler;
