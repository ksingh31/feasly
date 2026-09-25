/**
 * Invoice-reviewer timer service (billing/02).
 *
 * Runs daily (see `invoice-reviewer-timer/function.json`): for every
 * in-review commission invoice whose review window has passed and which is
 * NOT disputed, finalize → create the off-session PaymentIntent against the
 * saved card. Disputed rows are skipped — the dispute froze the charge
 * clock until a human resolves it.
 *
 * Never lets one bad invoice kill the batch: per-invoice errors are
 * collected and returned (the timer logs aggregates, never PII).
 */
import type { BillingConfig } from '../../config';
import type { CommissionService } from './commission.service';
import type { BillingAuditService } from './billing-audit.service';

export interface InvoiceReviewerResult {
  readonly finalized: number;
  readonly skipped: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ invoiceId: string; message: string }>;
}

export interface InvoiceReviewerService {
  /** One daily cycle: finalize every due review. */
  runReviewCycle(now: Date): Promise<InvoiceReviewerResult>;
}

export interface InvoiceReviewerServiceDeps {
  readonly billing: BillingConfig;
  readonly commission: CommissionService;
  readonly audit: BillingAuditService;
}

export function createInvoiceReviewerService(
  deps: InvoiceReviewerServiceDeps,
): InvoiceReviewerService {
  const { billing, commission, audit } = deps;

  return {
    async runReviewCycle(reviewNow: Date): Promise<InvoiceReviewerResult> {
      // The reviewer only charges under the commission model — under 'flat'
      // the cycle is a no-op (flat charges run through Stripe subscriptions).
      if (billing.model !== 'commission') {
        return { finalized: 0, skipped: 0, failed: 0, errors: [] };
      }
      const due = await commission.findDueReviews(reviewNow);
      let finalized = 0;
      let failed = 0;
      const errors: Array<{ invoiceId: string; message: string }> = [];

      for (const invoice of due) {
        try {
          await commission.finalizeInvoice(invoice.id);
          finalized += 1;
        } catch (error) {
          failed += 1;
          errors.push({
            invoiceId: invoice.id,
            message:
              error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      await audit.append({
        tenantKey: null,
        eventType: 'reviewer.cycle_completed',
        entityType: 'invoice_reviewer',
        entityId: `cycle-${reviewNow.toISOString()}`,
        payload: { finalized, skipped: 0, failed, due: due.length },
      });

      return { finalized, skipped: 0, failed, errors };
    },
  };
}
