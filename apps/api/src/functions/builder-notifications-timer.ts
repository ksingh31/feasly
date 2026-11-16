/**
 * Azure Functions v3 timer-trigger adapter — builder notifications (#725).
 *
 * Schedule (function.json): `0 15 * * * *` — quarter past every hour, UTC. A new
 * function in the existing Function App (no new Azure resource). Each tick:
 *   - retries pending new-lead emails whose first attempt failed (send-once
 *     outbox, bounded by BUILDER_NOTIFICATION_MAX_ATTEMPTS);
 *   - from BUILDER_DIGEST_LOCAL_HOUR (America/Edmonton) on, builds the
 *     daily "Needs you" digest for opted-in members — once per local day,
 *     never for an empty feed.
 * BUILDER_NOTIFICATIONS_ENABLED=false makes the cycle a no-op.
 *
 * No PII is logged — only aggregate counts.
 *
 * Bundled by `npm run bundle:functions` into `builder-notifications-timer/index.js`.
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
export async function runBuilderNotificationsTimer(
  app: Pick<AppComposition, 'builderNotificationsService'>,
  context: TimerFunctionContext,
): Promise<void> {
  let result;
  try {
    result = await app.builderNotificationsService.runCycle();
  } catch (error) {
    context.log(
      `builder-notifications-timer: CYCLE FAILED (error=${sanitizeErrorMessage(error)})`,
    );
    throw error;
  }
  context.log(
    `builder-notifications-timer: cycle complete (sent=${result.sent} skipped=${result.skipped} ` +
      `failed=${result.failed} digestsQueued=${result.digestsQueued})`,
  );
}

export async function builderNotificationsTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  await runBuilderNotificationsTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderNotificationsTimerHandler;
