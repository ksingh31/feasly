/**
 * Azure Functions v3 timer-trigger adapter — monthly community-stats
 * refresh (neighbourhood/05).
 *
 * Schedule (function.json): `0 0 0 1 * *` — 00:00 UTC on the 1st of every
 * month (the story's `0 0 1 * *` in 5-field cron; NCRONTAB needs the
 * seconds field). Recomputes `community_stats` from fresh City of Calgary
 * Socrata aggregates so the API stays cache-first.
 *
 * Failure semantics live in the service: two consecutive timer failures
 * fire the `community_stats_failed` ops alert (admin/06); the first
 * success afterwards sends the all-clear. A throw here is a cycle
 * failure — the Functions host logs it and retries per host policy.
 *
 * No PII is logged — only aggregate counts (refreshed / skipped /
 * roll year).
 *
 * Bundled by `npm run bundle:functions` into
 * `community-stats-refresh-timer/index.js` (self-contained — the Function
 * App has no node_modules).
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

export async function communityStatsRefreshTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const result = await app.communityStatsRefreshService.runRefreshCycle();
  // Aggregates only — never community names or assessment internals.
  context.log(
    `community-stats-refresh-timer: cycle complete ` +
      `(refreshed=${result.refreshed} skipped=${result.skipped} ` +
      `roll_year=${result.rollYear})`,
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = communityStatsRefreshTimerHandler;
