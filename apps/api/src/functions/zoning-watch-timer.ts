/**
 * Azure Functions v3 timer-trigger adapter — daily zoning source watch (#757).
 *
 * Schedule (function.json): `0 30 11 * * *` — 11:30 UTC daily (04:30/05:30
 * Calgary), after the City's overnight open-data refresh. Checks the Land
 * Use Districts dataset metadata and the Land Use Bylaw page; on a change it
 * refreshes cached districts and files one "Zoning catalogue may be out of
 * date" issue (see services/zoning-watch.service.ts).
 *
 * A throw here is a cycle failure — the Functions host logs it and the next
 * day's run retries. Only aggregate flags are logged (public City metadata).
 *
 * Bundled by `npm run bundle:functions` into `zoning-watch-timer/index.js`.
 */
import { createComposition, type AppComposition } from '../index';
import type { TimerFunctionContext } from './community-stats-refresh-timer';

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

export async function zoningWatchTimerHandler(context: TimerFunctionContext): Promise<void> {
  const result = await getApp().zoningWatchService.runCheck();
  context.log(
    `zoning-watch-timer: cycle complete (skipped=${result.skipped} ` +
      `dataset_changed=${result.datasetChanged} bylaw_changed=${result.bylawChanged} ` +
      `unknown_codes=${result.unknownDistrictCodes.length} refreshed=${result.cacheEntriesRefreshed} ` +
      `issue=${result.issue} stale=${result.stale})`,
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = zoningWatchTimerHandler;
