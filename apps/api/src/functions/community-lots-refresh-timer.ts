/**
 * Azure Functions v3 timer-trigger adapter — weekly community-lots refresh
 * (#691).
 *
 * Schedule (function.json): `0 30 9 * * 1` — 09:30 UTC every Monday, after
 * the City's weekly Land Use Districts update. Derives the vacant
 * residential lots in established infill communities from City open data.
 *
 * Failure semantics live in the service: a community that fails keeps its
 * stored lots; a run with any failed community is reported failed (this
 * adapter throws so the Functions host records the failure) and fires the
 * `community_lots_failed` ops alert; the next clean run clears it.
 *
 * No PII is logged — aggregate counts and the measured duration only.
 *
 * Bundled by `npm run bundle:functions` into
 * `community-lots-refresh-timer/index.js` (self-contained).
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

export async function communityLotsRefreshTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const r = await app.communityLotsRefreshService.runRefreshCycle();
  const ex = r.excluded;
  context.log(
    `community-lots-refresh-timer: ${r.status} ` +
      `(roll_year=${r.rollYear} communities=${r.communities} failed=${r.failedCommunities} ` +
      `listed=${r.listed} inserted=${r.inserted} updated=${r.updated} unchanged=${r.unchanged} ` +
      `removed=${r.removed} communities_removed=${r.communitiesRemoved} ` +
      `excluded_sliver=${ex.sliver} excluded_district=${ex['district-not-allowed']} ` +
      `excluded_other=${ex.unparseable + ex['not-residential-vacant'] + ex['no-assessed-value']} ` +
      `duration_ms=${r.durationMs})`,
  );
  if (r.status === 'failed') {
    throw new Error(
      `community-lots-refresh-timer: ${r.failedCommunities} community(ies) failed; stored lots kept`,
    );
  }
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = communityLotsRefreshTimerHandler;
