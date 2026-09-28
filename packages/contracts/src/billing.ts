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

/**
 * Card-on-file status — GET /api/v1/billing/card (billing/02, BILL-02).
 * Display-safe summary only: brand/last4/expiry. The PAN never leaves
 * Stripe.
 */
export interface CardOnFileStatus {
  readonly hasCard: boolean;
  readonly brand?: string;
  readonly last4?: string;
  readonly expMonth?: number;
  readonly expYear?: number;
}

/** Result of POST /api/v1/billing/setup-intent (billing/02, BILL-02). */
export interface SetupIntentResponse {
  readonly setupIntentId: string;
  readonly clientSecret: string;
}

/**
 * Dispute console contracts (billing/01 follow-on, was OPS-009).
 *
 * Wire shapes for `/api/v1/admin/disputes/*`. Dates are ISO-8601 strings.
 * The evidence snapshot is immutable server-side: the console renders it,
 * never the live invoice row, so the evidence can't change under review.
 */

/** Dispute lifecycle: open → accepted | rejected. */
export type DisputeStatus = 'open' | 'accepted' | 'rejected';

/** Immutable invoice state captured at dispute-open time. */
export interface DisputeEvidenceSnapshot {
  readonly invoiceId: string;
  readonly tenantKey: string;
  readonly attributionId: string;
  readonly leadId: string;
  /** Signed construction contract value, integer cents, excl. land. */
  readonly contractValueCents: number;
  /** round(contractValueCents * rate), integer cents. */
  readonly commissionCents: number;
  readonly currency: string;
  readonly stripePaymentIntentId: string | null;
  readonly status: 'disputed';
  readonly reviewDueAt: string | null;
  readonly disputeReason: string;
  readonly invoiceCreatedAt: string;
  readonly disputedAt: string;
  /** True when backfilled for a disputed invoice with no dispute row. */
  readonly backfilled?: boolean;
}

export interface DisputeListItem {
  readonly id: string;
  readonly invoiceId: string;
  readonly tenantKey: string;
  readonly reason: string;
  readonly status: DisputeStatus;
  readonly openedAt: string;
  /** openedAt + 5 business days (America/Edmonton). */
  readonly slaDueAt: string;
  /** When the SLA-breach ops escalation fired; null until then. */
  readonly slaBreachedAt: string | null;
  readonly commissionCents: number;
  readonly currency: string;
  readonly contractValueCents: number;
  /** Whole business days until slaDueAt (negative when breached). */
  readonly businessDaysRemaining: number;
  /** True when now is past slaDueAt. */
  readonly breached: boolean;
}

/** GET /api/v1/admin/disputes — open disputes, oldest first. */
export interface DisputeListResponse {
  readonly disputes: DisputeListItem[];
}

/** GET /api/v1/admin/disputes/{id} — full detail for the console. */
export interface DisputeDetailResponse extends DisputeListItem {
  readonly evidenceSnapshot: DisputeEvidenceSnapshot;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
  /** billing_events rows for the dispute + its invoice, oldest first. */
  readonly auditTrail: BillingEvent[];
}

/** POST /api/v1/admin/disputes/{id}/accept and …/reject. */
export interface ResolveDisputeRequest {
  /** Optional admin note recorded on the dispute + audit trail. */
  readonly note?: string;
}
