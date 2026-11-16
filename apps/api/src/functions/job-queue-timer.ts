/**
 * Azure Functions v3 timer-trigger adapter — job-queue worker (#838).
 *
 * Schedule (function.json): every 5 minutes, UTC.
 * Claims one batch of due jobs from the Postgres `jobs` table
 * (FOR UPDATE SKIP LOCKED — overlapping instances never double-process)
 * and runs each job's handler; failures retry with backoff and
 * dead-letter after JOB_QUEUE_MAX_ATTEMPTS.
 *
 * No PII is logged — only aggregate counts.
 *
 * Bundled by `npm run bundle:functions` into `job-queue-timer/index.js`.
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
 * The timer's work, extracted for testability. A run-level throw (e.g. the
 * claim query dies) logs a structured, sanitized RUN FAILED line (#217
 * pattern) and rethrows so the host records the invocation failure.
 */
export async function runJobQueueTimer(
  app: { readonly jobQueueService: Pick<AppComposition['jobQueueService'], 'runOnce'> },
  context: TimerFunctionContext,
): Promise<void> {
  let result: Awaited<ReturnType<AppComposition['jobQueueService']['runOnce']>>;
  try {
    result = await app.jobQueueService.runOnce();
  } catch (error) {
    context.log(`job-queue-timer: RUN FAILED (error=${sanitizeErrorMessage(error)})`);
    throw error;
  }
  context.log(
    `job-queue-timer: run complete (claimed=${result.claimed} done=${result.done} ` +
      `retried=${result.retried} dead=${result.deadLettered})`,
  );
}

export async function jobQueueTimerHandler(context: TimerFunctionContext): Promise<void> {
  await runJobQueueTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = jobQueueTimerHandler;
