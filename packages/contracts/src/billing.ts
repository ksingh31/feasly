/**
 * Billing contracts (billing/02 commission engine).
 *
 * Shapes only: no logic, no math, no secrets. Mirrors the
 * `commission_invoices` / `billing_events` tables and the Stripe webhook
 * route's wire shape.
 */

/** Commission invoice lifecycle — see TECH_PLAN §2.4. */
export type CommissionInvoiceStatus =
  | 'draft'
  | 'in_review'
  | 'finalized'
  | 'paid'
  | 'failed'
  | 'disputed'
  | 'void';

export interface CommissionInvoice {
  readonly id: string;
  readonly tenantKey: string;
  readonly attributionId: string;
  readonly leadId: string;
  /** Signed construction contract value, integer cents, excl. land. */
  readonly contractValueCents: number;
  /** round(contractValueCents * rate), integer cents. */
  readonly commissionCents: number;
  readonly currency: string;
  /** Off-session PaymentIntent id — set at finalize. Null before. */
  readonly stripePaymentIntentId: string | null;
  readonly status: CommissionInvoiceStatus;
  /** draft created + 7 days — the builder's review/dispute window. */
  readonly reviewDueAt: string | null;
  readonly finalizedAt: string | null;
  readonly paidAt: string | null;
  /** True when the contract was reported after the 14-day reporting SLA. */
  readonly slaBreached: boolean;
  readonly disputeReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Append-only billing audit event. */
export interface BillingEvent {
  readonly id: string;
  readonly tenantKey: string | null;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: Record<string, unknown> | null;
  readonly createdAt: string;
}

/** Result of POST /api/v1/stripe/webhooks. */
export interface StripeWebhookResult {
  readonly received: boolean;
  /** True when this event id was already handled (Stripe retry). */
  readonly duplicate: boolean;
}
