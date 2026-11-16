/**
 * Invoice-reviewer timer service (billing/02).
 *
 * Runs daily (see `invoice-reviewer-timer/function.json`): for every
 * in-review commission invoice whose review window has passed and which is
 * NOT disputed, finalize → create the off-session PaymentIntent against the
 * saved card. Disputed rows are skipped — the dispute froze the charge
 * clock until a human resolves it. Invoices whose paymentMethod is manual
 * (billing/12: cheque, e-transfer, bank draft) are skipped too — choosing
 * a manual method pauses the auto-charge until staff marks the invoice
 * paid.
 *
 * Reconciliation (#711): after finalizing, every invoice that has sat
 * 'finalized' (charge in progress) longer than
 * BILLING_SETTLEMENT_THRESHOLD_HOURS is checked against Stripe — the
 * webhook that should have settled it may never have landed. The
 * PaymentIntent's real status settles it: `succeeded` → paid,
 * `requires_payment_method` / `canceled` → failed (dunning), anything else
 * (`processing`, `requires_action`, …) stays pending. Settlement audit rows
 * carry `source: 'reconciliation'`. Read-only against Stripe.
 *
 * Dunning (#718): failed card invoices whose automatic retry is due (one
 * grace period after the failure, schedule active, retries left) are
 * re-charged with a fresh idempotency key per attempt; a transient error
 * leaves the invoice due, so the next cycle replays the same key. Manual-
 * method invoices past their due date get one overdue reminder.
 *
 * Never lets one bad invoice kill the batch: per-invoice errors are
 * collected and returned (the timer logs aggregates, never PII).
 */
import type { BillingConfig } from '../../config';
import type { CommissionService } from './commission.service';
import type { BillingAuditService } from './billing-audit.service';
import type { StripeService } from './stripe.service';
import { AUTHENTICATION_REQUIRED_CODE } from '../../lib/charge-outcome';
import { builderStatusAllows } from '../../lib/builder-status-policy';

/** Default hours before a 'finalized' invoice is reconciled (#711). */
const DEFAULT_SETTLEMENT_THRESHOLD_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/** PaymentIntent statuses that mean the charge definitively failed. */
const FAILED_PI_STATUSES: ReadonlySet<string> = new Set([
  'requires_payment_method',
  'canceled',
]);

export interface InvoiceReviewerResult {
  readonly finalized: number;
  readonly skipped: number;
  readonly failed: number;
  /** #711: stuck 'finalized' invoices settled paid from Stripe. */
  readonly reconciledPaid: number;
  /** #711: stuck 'finalized' invoices settled failed from Stripe. */
  readonly reconciledFailed: number;
  /**
   * #711: stuck invoices whose PaymentIntent is still in flight, or (#712)
   * now waiting on the builder's 3DS confirmation.
   */
  readonly stillPending: number;
  /** #718: failed card invoices re-charged on their dunning schedule. */
  readonly retried: number;
  /** #718: manual-method invoices sent their overdue reminder. */
  readonly overdueReminded: number;
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
  /** Read-only PaymentIntent lookup for reconciliation (#711). */
  readonly stripe: Pick<StripeService, 'retrievePaymentIntent'>;
  /**
   * #860: the builder's lifecycle status by tenant key (null = unknown
   * tenant). When the policy refuses `autoCharge` (suspended, offboarded)
   * the invoice is held — not charged, counted as skipped. Absent = no hold.
   */
  readonly builderStatus?: (tenantKey: string) => Promise<string | null>;
}

export function createInvoiceReviewerService(
  deps: InvoiceReviewerServiceDeps,
): InvoiceReviewerService {
  const { billing, commission, audit, stripe } = deps;

  /** #860: true when the builder's status pauses auto-charging. */
  async function chargeHeld(tenantKey: string): Promise<boolean> {
    if (!deps.builderStatus) return false;
    const status = await deps.builderStatus(tenantKey);
    return status !== null && !builderStatusAllows(status, 'autoCharge');
  }

  interface ReconcileResult {
    reconciledPaid: number;
    reconciledFailed: number;
    stillPending: number;
    failed: number;
    errors: Array<{ invoiceId: string; message: string }>;
  }

  async function reconcile(
    reviewNow: Date,
    // Invoices finalized in THIS cycle are never stuck — skip them even if
    // the threshold is tiny.
    justFinalized: ReadonlySet<string>,
  ): Promise<ReconcileResult> {
    const thresholdHours =
      billing.settlementThresholdHours ?? DEFAULT_SETTLEMENT_THRESHOLD_HOURS;
    const cutoff = new Date(reviewNow.getTime() - thresholdHours * HOUR_MS);
    const stuck = (await commission.findAwaitingSettlement(cutoff)).filter(
      (invoice) => !justFinalized.has(invoice.id),
    );
    const result: ReconcileResult = {
      reconciledPaid: 0,
      reconciledFailed: 0,
      stillPending: 0,
      failed: 0,
      errors: [],
    };
    for (const invoice of stuck) {
      const piId = invoice.stripePaymentIntentId;
      if (piId === null) continue;
      try {
        const intent = await stripe.retrievePaymentIntent(piId);
        if (intent.status === 'succeeded') {
          await commission.markPaidByPaymentIntent(piId, {
            source: 'reconciliation',
          });
          result.reconciledPaid += 1;
        } else if (intent.lastPaymentErrorCode === AUTHENTICATION_REQUIRED_CODE) {
          // #712: Stripe leaves an off-session 3DS demand in
          // requires_payment_method + authentication_required — recoverable
          // on-session, so the invoice waits on the builder instead of
          // entering dunning. Still unsettled, so it counts as pending.
          await commission.markActionRequiredByPaymentIntent(piId, {
            source: 'reconciliation',
          });
          result.stillPending += 1;
        } else if (FAILED_PI_STATUSES.has(intent.status)) {
          await commission.markFailedByPaymentIntent(
            piId,
            intent.lastPaymentErrorMessage,
            { source: 'reconciliation' },
          );
          result.reconciledFailed += 1;
        } else {
          result.stillPending += 1;
        }
      } catch (error) {
        result.failed += 1;
        result.errors.push({
          invoiceId: invoice.id,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    return result;
  }

  return {
    async runReviewCycle(reviewNow: Date): Promise<InvoiceReviewerResult> {
      // The reviewer only charges under the commission model — under 'flat'
      // the cycle is a no-op (flat charges run through Stripe subscriptions).
      if (billing.model !== 'commission') {
        return {
          finalized: 0,
          skipped: 0,
          failed: 0,
          reconciledPaid: 0,
          reconciledFailed: 0,
          stillPending: 0,
          retried: 0,
          overdueReminded: 0,
          errors: [],
        };
      }
      const due = await commission.findDueReviews(reviewNow);
      // billing/12: manual-method invoices are skipped by findDueReviews
      // (no auto-charge, no card retry) — count them for observability.
      const skippedManual = await commission.countSkippedManualReviews(reviewNow);
      let heldByStatus = 0;
      let finalized = 0;
      let failed = 0;
      const errors: Array<{ invoiceId: string; message: string }> = [];
      const justFinalized = new Set<string>();

      for (const invoice of due) {
        try {
          if (await chargeHeld(invoice.tenantKey)) {
            heldByStatus += 1;
            continue;
          }
          await commission.finalizeInvoice(invoice.id);
          justFinalized.add(invoice.id);
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

      // #718: automatic retries due on the dunning schedule.
      let retried = 0;
      for (const invoice of await commission.findDueRetries(reviewNow)) {
        try {
          await commission.retryCharge(invoice.id, { trigger: 'schedule' });
          justFinalized.add(invoice.id);
          retried += 1;
        } catch (error) {
          failed += 1;
          errors.push({
            invoiceId: invoice.id,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // #718: one overdue reminder per manual-method invoice.
      let overdueReminded = 0;
      for (const invoice of await commission.findOverdueManualInvoices(reviewNow)) {
        try {
          if ((await commission.sendOverdueReminder(invoice.id)) !== null) {
            overdueReminded += 1;
          }
        } catch (error) {
          failed += 1;
          errors.push({
            invoiceId: invoice.id,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      const skipped = skippedManual + heldByStatus;
      const reconciled = await reconcile(reviewNow, justFinalized);
      failed += reconciled.failed;
      errors.push(...reconciled.errors);
      const { reconciledPaid, reconciledFailed, stillPending } = reconciled;

      await audit.append({
        tenantKey: null,
        eventType: 'reviewer.cycle_completed',
        entityType: 'invoice_reviewer',
        entityId: `cycle-${reviewNow.toISOString()}`,
        payload: {
          finalized,
          skipped,
          failed,
          due: due.length,
          heldByStatus,
          reconciledPaid,
          reconciledFailed,
          stillPending,
          retried,
          overdueReminded,
        },
      });

      return {
        finalized,
        skipped,
        failed,
        reconciledPaid,
        reconciledFailed,
        stillPending,
        retried,
        overdueReminded,
        errors,
      };
    },
  };
}
