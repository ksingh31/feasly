/**
 * Azure Functions v3 timer-trigger adapter — dispute SLA watchdog
 * (billing/01 follow-on, was OPS-009).
 *
 * Schedule (function.json): `0 0 13 * * *` — daily at 13:00 UTC (06:00
 * America/Edmonton). Scans for open disputes past their 5-business-day
 * SLA and escalates each via the ops-alerts service (deduped: at most one
 * email per alert class per 24h).
 *
 * A breach NEVER auto-resolves the dispute — it stays open until a human
 * accepts or rejects it in the console.
 *
 * No PII is logged — only the escalated count.
 *
 * Bundled by `npm run bundle:functions` into `dispute-sla-timer/index.js`
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

export async function disputeSlaTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const { escalated } = await app.disputeService.scanSlaBreaches(new Date());
  context.log(`dispute-sla-timer: cycle complete (escalated=${escalated})`);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = disputeSlaTimerHandler;
