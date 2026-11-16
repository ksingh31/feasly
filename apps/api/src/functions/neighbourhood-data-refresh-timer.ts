/**
 * Azure Functions v3 timer-trigger adapter — neighbourhood data refresh (#773).
 *
 * Ticks daily at 07:00 UTC (function.json `0 0 7 * * *`). The MONTHLY
 * schedule lives in config (NEIGHBOURHOOD_REFRESH_DAY_OF_MONTH): each tick
 * refreshes only the providers that are due, so a failed or interrupted run
 * resumes the next day and the "3 days of failures" alert can fire.
 *
 * Never throws for a single provider failure (the service records it and
 * keeps the previous data). Logs counts only — no PII.
 *
 * Bundled by `npm run bundle:functions` into
 * `neighbourhood-data-refresh-timer/index.js`.
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

export async function neighbourhoodDataRefreshTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const { results } = await app.neighbourhoodRefreshService.runDue();
  const summary = results
    .map((r) => `${r.provider}=${r.outcome}:${r.rowsChanged}`)
    .join(' ');
  context.log(
    `neighbourhood-data-refresh-timer: tick complete (ran=${results.length}${summary ? ` ${summary}` : ''})`,
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = neighbourhoodDataRefreshTimerHandler;
