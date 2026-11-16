/**
 * Billing-health dashboard contracts (billing/03 follow-on — /admin/billing,
 * was OPS-007).
 *
 * Shapes only: no logic, no math, no secrets. Read-only — the dashboard
 * exposes no charge/refund/void actions; the wire shape is a single
 * aggregated payload for `GET /api/v1/admin/billing`.
 */

import type { BuilderPaymentMethod, DunningState } from './billing';

/** Active billing model (Karan 2026-09-24: commission; config-switchable). */
export type BillingHealthModel = 'commission' | 'flat';

/** Count + summed commission for a group of invoices (integer cents). */
export interface BillingHealthBucket {
  readonly count: number;
  readonly commissionCents: number;
}

/** A commission invoice stuck in dunning (charge failed, awaiting retry). */
export interface BillingHealthDunningInvoice {  readonly id: string;
  readonly tenantKey: string;
  /** Integer cents. */
  readonly commissionCents: number;
  readonly currency: string;
  /** Effective commission rate in PERCENT (admin override when set). */
  readonly commissionRatePercent: number;
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
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
  /**
   * How this invoice gets paid (billing/12): 'card' = the normal Stripe
   * off-session auto-charge; cheque/e_transfer/bank_draft = manual — the
   * invoice sits until staff marks it paid.
   */
  readonly paymentMethod: BuilderPaymentMethod;
  /*
   * Dunning schedule (#718). Optional only so pre-#718 fixtures compile;
   * the API always sends them.
   */
  /** ISO 8601 — next automatic retry; null when none is scheduled. */
  readonly nextRetryAt?: string | null;
  /** Admin control over automatic retries (active | paused | cancelled). */
  readonly dunningState?: DunningState;
  /** Grace period in days between a failed charge and the next retry. */
  readonly retryGraceDays?: number;
  /**
   * ISO 8601 — when the final automatic retry failed. Non-null = flagged
   * for collections; these sort to the top of the dunning queue.
   */
  readonly collectionsAt?: string | null;
}

/** An in-review commission invoice, for the admin billing work queue. */
export interface BillingHealthInReviewInvoice {
  readonly id: string;
  readonly tenantKey: string;
  /** Integer cents. */
  readonly commissionCents: number;
  readonly currency: string;
  /** End of the 7-day review/dispute window; null when not set. */
  readonly reviewDueAt: string | null;
  /**
   * Effective commission rate, in PERCENT (e.g. 1.5 = 1.5%) — the admin
   * override when set, otherwise the configured default rate.
   */
  readonly commissionRatePercent: number;
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
  /**
   * How this invoice gets paid (billing/12): 'card' = the normal Stripe
   * off-session auto-charge; cheque/e_transfer/bank_draft = manual — the
   * invoice sits until staff marks it paid.
   */
  readonly paymentMethod: BuilderPaymentMethod;
  /**
   * #718: manual-method invoices only — ISO 8601 due date (review window
   * end + grace period). Null for card invoices. Optional only so pre-#718
   * fixtures compile.
   */
  readonly dueAt?: string | null;
  /**
   * #718: whole days a manual-method invoice is past `dueAt` ("awaiting
   * manual payment — N days"); 0 when not overdue or a card invoice.
   */
  readonly overdueDays?: number;
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

/**
 * A Stripe event recorded in `stripe_events` whose handler never completed
 * (#711) — Stripe's redelivery re-runs it; it lingers here if Stripe gave up.
 */
export interface BillingHealthUnprocessedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly receivedAt: string;
}

/**
 * A commission invoice 'finalized' (charge in progress) for longer than the
 * settlement threshold (#711) — the settling webhook never landed. The daily
 * reconciliation reads the PaymentIntent from Stripe and settles it.
 */
export interface BillingHealthAwaitingSettlementInvoice {
  readonly id: string;
  readonly tenantKey: string;
  readonly commissionCents: number;
  readonly currency: string;
  /** When the invoice entered 'finalized' (ISO). */
  readonly awaitingSince: string;
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
  /**
   * #711: events received but not processed (handler threw and no
   * successful redelivery yet), oldest first, bounded. Any age — excludes
   * only events received in the last few minutes (still in flight).
   */
  readonly unprocessed: ReadonlyArray<BillingHealthUnprocessedEvent>;
  /**
   * #711: invoices awaiting settlement longer than
   * `settlementThresholdHours`, oldest first, bounded.
   */
  readonly awaitingSettlement: ReadonlyArray<BillingHealthAwaitingSettlementInvoice>;
  /** BILLING_SETTLEMENT_THRESHOLD_HOURS — the "stuck" cut-off. */
  readonly settlementThresholdHours: number;
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
    /**
     * #753: active payment provider. The admin dev panel (fire dispute /
     * refund / delayed failure) shows only when this is `simulated`.
     */
    readonly provider?: 'stripe' | 'simulated';
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
  /**
   * In-review invoices for the admin work queue — the rows an admin can
   * mark as paid (off-Stripe), override the commission rate on, or change
   * the planned payment method on.
   * Ordered by review window (most urgent first), bounded.
   */
  readonly inReviewInvoices: ReadonlyArray<BillingHealthInReviewInvoice>;
  /** Max off-session charge retries per failed invoice (BILL-03). */
  readonly maxChargeRetries: number;
  readonly webhooks: BillingHealthWebhooks;
}
