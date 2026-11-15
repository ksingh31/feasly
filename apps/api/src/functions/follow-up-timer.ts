/**
 * Azure Functions v3 timer-trigger adapter — post-report follow-up (#703).
 *
 * Schedule (function.json): `0 30 * * * *` — half past every hour, UTC
 * (offset from the nudge timer at the top of the hour). Runs the
 * follow-up service's cycle; the service enforces exactly-once
 * (`follow_up_sent_at`), marketing consent, opt-outs, and the
 * FOLLOW_UP_EMAIL_ENABLED flag (default off → the cycle is a no-op).
 *
 * No PII is logged — only aggregate counts (sent / skipped).
 *
 * Bundled by `npm run bundle:functions` into `follow-up-timer/index.js`.
 */
import { createComposition, type AppComposition } from '../index';
import { sanitizeErrorMessage } from '../lib/sanitize-error';

export interface TimerFunctionContext {
  log: (...args: unknown[]) => void;
}

let cached: AppComposition | undefined;

function getApp(): AppComposition {
  if (!cached) cached = createComposition();
  return cached;
}

/**
 * The timer's work, extracted for testability. A cycle-level throw logs a
 * structured, sanitized CYCLE FAILED line (#217 pattern) and rethrows so
 * the host records the invocation failure.
 */
export async function runFollowUpTimer(
  app: Pick<AppComposition, 'followUpService'>,
  context: TimerFunctionContext,
): Promise<void> {
  let sent: number;
  let skipped: number;
  try {
    ({ sent, skipped } = await app.followUpService.runFollowUpCycle());
  } catch (error) {
    context.log(
      `follow-up-timer: CYCLE FAILED (error=${sanitizeErrorMessage(error)})`,
    );
    throw error;
  }
  context.log(`follow-up-timer: cycle complete (sent=${sent} skipped=${skipped})`);
}

export async function followUpTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  await runFollowUpTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = followUpTimerHandler;
