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

/** Minimal structural types — no @azure/functions dependency needed. */
export interface TimerFunctionContext {
  log: (...args: unknown[]) => void;
}

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

export async function nudgeTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const { nudged, skipped } = await app.nudgeService.runNudgeCycle();
  // Aggregates only — never lead emails, ids, or tokens.
  context.log(`nudge-timer: cycle complete (nudged=${nudged} skipped=${skipped})`);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = nudgeTimerHandler;
