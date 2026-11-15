/**
 * Azure Functions v3 timer-trigger adapter — email outbox drain (#750).
 *
 * Schedule (function.json): `0 *\/15 * * * *` — every 15 minutes.
 * When the global daily email cap is reached, the email service queues
 * non-exempt mail in `email_outbox`; this timer sends it oldest-first once
 * budget is available again (after midnight UTC) and drops rows older than
 * EMAIL_OUTBOX_MAX_AGE_HOURS. A normal day has an empty outbox, so a run is
 * one DELETE plus one counter read.
 *
 * Logs counts only — never recipients or message bodies. A throw is logged
 * as `CYCLE FAILED` and rethrown so the host records the failure.
 *
 * Bundled by `npm run bundle:functions` into `email-outbox-timer/index.js`.
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

/** The timer's work, extracted for testability. */
export async function runEmailOutboxTimer(
  app: Pick<AppComposition, 'emailOutboxService'>,
  context: TimerFunctionContext,
): Promise<void> {
  let result;
  try {
    result = await app.emailOutboxService.drain();
  } catch (error) {
    context.log(
      `email-outbox-timer: CYCLE FAILED (error=${sanitizeErrorMessage(error)})`,
    );
    throw error;
  }
  if (result.sent + result.failed + result.retrying + result.expired === 0) {
    return; // Nothing queued — the normal case.
  }
  context.log(
    `email-outbox-timer: sent=${result.sent} failed=${result.failed} ` +
      `retrying=${result.retrying} expired=${result.expired}`,
  );
}

export async function emailOutboxTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  await runEmailOutboxTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = emailOutboxTimerHandler;
