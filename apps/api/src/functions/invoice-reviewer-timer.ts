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
 * No PII is logged — only aggregate counts (finalized / failed).
 *
 * Bundled by `npm run bundle:functions` into `invoice-reviewer-timer/index.js`
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

export async function invoiceReviewerTimerHandler(
  context: TimerFunctionContext,
): Promise<void> {
  const app = getApp();
  const { finalized, failed, errors } =
    await app.invoiceReviewerService.runReviewCycle(new Date());
  // Aggregates only — never invoice ids, tenant keys, or amounts.
  context.log(
    `invoice-reviewer-timer: cycle complete (finalized=${finalized} failed=${failed})`,
  );
  for (const error of errors) {
    context.log(`invoice-reviewer-timer: invoice failed: ${error.message}`);
  }
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = invoiceReviewerTimerHandler;
