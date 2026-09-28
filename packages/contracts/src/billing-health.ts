/**
 * Billing-health dashboard contracts (billing/03 follow-on — /admin/billing,
 * was OPS-007).
 *
 * Shapes only: no logic, no math, no secrets. Read-only — the dashboard
 * exposes no charge/refund/void actions; the wire shape is a single
 * aggregated payload for `GET /api/v1/admin/billing`.
 */

/** Active billing model (Karan 2026-09-24: commission; config-switchable). */
export type BillingHealthModel = 'commission' | 'flat';

/** Count + summed commission for a group of invoices (integer cents). */
export interface BillingHealthBucket {
  readonly count: number;
  readonly commissionCents: number;
}

/** A commission invoice stuck in dunning (charge failed, awaiting retry). */
export interface BillingHealthDunningInvoice {
  readonly id: string;
  readonly tenantKey: string;
  /** Integer cents. */
  readonly commissionCents: number;
  readonly currency: string;
  /** When the charge failure moved the invoice into dunning. */
  readonly pastDueSince: string;
  /**
   * Off-session charge retry attempts made (BILL-03). 0 = the initial
   * finalize charge. Capped by BILLING_MAX_CHARGE_RETRIES.
   */
  readonly retryCount: number;
  /**
   * Stripe's last_payment_error message from the latest failed charge,
   * or null when no reason was recorded. Shown in the dunning queue.
   */
  readonly lastFailureReason: string | null;
}

/** MRR as reported by the dashboard. */
export interface BillingHealthMrr {
  /**
   * Flat model: sum of active Stripe subscription monthly amounts, derived
   * from the `subscription.created`/`subscription.cancelled` audit trail.
   * Null under the commission model — there are no subscriptions there.
   */
  readonly cents: number | null;
  readonly currency: string;
  readonly activeSubscriptions: number;
  /** 'stripe' when computed from Stripe subscription data; 'not_applicable' under commission. */
  readonly source: 'stripe' | 'not_applicable';
}

/** Stripe webhook receiver health over the trailing 24h. */
export interface BillingHealthWebhooks {
  readonly received24h: number;
  readonly lastReceivedAt: string | null;
  readonly byType24h: ReadonlyArray<{
    readonly type: string;
    readonly count: number;
  }>;
  /**
   * `webhook.unhandled` audit rows in the last 24h — event types the
   * dispatcher logged without a handler. Duplicates are claimed by the
   * idempotency insert and never reach dispatch, so they are not counted
   * here.
   */
  readonly unhandled24h: number;
  /** `webhook.model_mismatch` audit rows in the last 24h. */
  readonly modelMismatch24h: number;
}

/**
 * `GET /api/v1/admin/billing` — the billing-health dashboard payload.
 *
 * One aggregated call: MRR (from Stripe subscription data under the flat
 * model), in-review invoice aging buckets, dunning states with
 * `past_due_since`, disputed-invoice totals, trailing-30d collections, and
 * the webhook health panel.
 */
export interface BillingHealthResponse {
  readonly model: BillingHealthModel;
  readonly stripe: {
    /** False when no STRIPE_SECRET_KEY is configured (billing dormant). */
    readonly configured: boolean;
    /** True when the configured key is a test key (`sk_test_…`). */
    readonly testMode: boolean;
  };
  readonly generatedAt: string;
  readonly mrr: BillingHealthMrr;
  /** Commission collected (paid invoices) in the trailing 30 days. */
  readonly collectedTrailing30d: BillingHealthBucket;
  /** In-review commission invoices by review-window age. */
  readonly inReview: {
    /** Created < 48h ago and not yet overdue. */
    readonly under48h: BillingHealthBucket;
    /** 48h–7d old and not yet overdue. */
    readonly under7d: BillingHealthBucket;
    /** Review window has passed (`reviewDueAt` ≤ now) — charge clock due. */
    readonly overdue: BillingHealthBucket;
  };
  readonly disputed: BillingHealthBucket;
  /** Failed-charge invoices with `past_due_since` — dunning work queue. */
  readonly dunning: ReadonlyArray<BillingHealthDunningInvoice>;
  /** Max off-session charge retries per failed invoice (BILL-03). */
  readonly maxChargeRetries: number;
  readonly webhooks: BillingHealthWebhooks;
}
