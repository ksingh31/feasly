/**
 * Azure Functions v3 timer-trigger adapter — monthly community narratives
 * (#759).
 *
 * Schedule (function.json): daily `0 0 9 * * *` — must equal
 * COMMUNITY_NARRATIVE_SCHEDULE (pinned by test). NCRONTAB has no "last day
 * of month", so the timer ticks daily and the service decides: on the run
 * day (config, default the last day) it generates next month's narrative
 * per community; the following retry days retry failures; other days only
 * finish rows an admin marked stale.
 *
 * Aggregate counts only are logged — never narrative text.
 *
 * Bundled by `npm run bundle:functions` into
 * `community-narrative-timer/index.js`.
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

export async function communityNarrativeTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const result = await app.communityNarrativeService.runScheduledTick();
  context.log(
    `community-narrative-timer: tick complete (period=${result.period ?? 'none'} ` +
      `attempted=${result.attempted} succeeded=${result.succeeded} failed=${result.failed} ` +
      `deferred=${result.deferred} alerted=${result.alerted})`,
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = communityNarrativeTimerHandler;
