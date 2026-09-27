/**
 * Azure Functions v3 timer-trigger adapter — daily invoice reviewer
 * (billing/02).
 *
 * Schedule (function.json): `0 0 0 * * *` — daily at 00:00 UTC. Runs the
 * invoice-reviewer service's cycle: for every in-review commission invoice
 * whose 7-day review window has passed and which is NOT disputed, create
 * the off-session Stripe PaymentIntent against the saved card.
 *
 * Disputed rows are skipped (the dispute froze the charge clock); one bad
 * invoice never kills the batch.
 *
 * Fail-visible: if the cycle dies on a top-level DB operation (e.g. the
 * `findDueReviews` SELECT or the cycle-completed `billing_events` INSERT
 * failing on schema drift — the Sep 2026 sheets-sync silent-failure class),
 * the adapter emits a structured, sanitized CYCLE FAILED line for Azure
 * Monitor to alert on, then rethrows so the host records the invocation
 * failure and retries on schedule.
 *
 * No PII is logged — only aggregate counts (finalized / failed).
 *
 * Bundled by `npm run bundle:functions` into `invoice-reviewer-timer/index.js`
 * (self-contained — the Function App has no node_modules).
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

/**
 * The timer's work, extracted for testability. Takes the composition (or a
 * test double with the same `invoiceReviewerService`) so the adapter test
 * can run the real service against a real database without the Azure host.
 *
 * This is the exact code path that would fail silently on Azure: the
 * Sep 2026 sheets-sync incident was a run-record INSERT dying on schema
 * drift, leaving zero trace in the ops panel. The adapter test pins this
 * timer's path against PGlite with the real migrations applied.
 */
export async function runInvoiceReviewerTimer(
  app: Pick<AppComposition, 'invoiceReviewerService'>,
  context: TimerFunctionContext,
): Promise<void> {
  let result;
  try {
    result = await app.invoiceReviewerService.runReviewCycle(new Date());
  } catch (error) {
    // Structured failure line: if the cycle dies before completing (e.g.
    // the `commission_invoices` SELECT or the `billing_events` INSERT fails
    // on schema drift), the ops panel never sees it, so this log line is
    // the backstop Azure Monitor can alert on. Rethrown so the host still
    // records the invocation failure and retries on schedule. The message
    // is sanitized — never credentials, never PII.
    context.log(
      `invoice-reviewer-timer: CYCLE FAILED (error=${sanitizeErrorMessage(error)})`,
    );
    throw error;
  }
  const { finalized, failed, skipped, errors } = result;
  // Aggregates only — never invoice ids, tenant keys, or amounts.
  context.log(
    `invoice-reviewer-timer: cycle complete (finalized=${finalized} failed=${failed} skipped=${skipped})`,
  );
  for (const error of errors) {
    context.log(
      `invoice-reviewer-timer: invoice failed: ${sanitizeErrorMessage(error.message)}`,
    );
  }
}

/**
 * Azure Functions v3 programming model entry point: builds (once) and
 * reuses the real composition, then runs one timer cycle.
 */
export async function invoiceReviewerTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  await runInvoiceReviewerTimer(getApp(), context);
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = invoiceReviewerTimerHandler;
