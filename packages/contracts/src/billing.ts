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
  /** round(contractValueCents * effectiveRate), integer cents. */
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
  /**
   * Admin override of the commission rate, in PERCENT (e.g. 1.5 = 1.5%).
   * Null = the configured default rate (BILLING_COMMISSION_RATE).
   */
  readonly commissionRateOverride: number | null;
  /**
   * Off-Stripe payment method recorded by an admin mark-paid action.
   * Null unless the invoice was manually marked paid.
   */
  readonly manualPaymentMethod: ManualPaymentMethod | null;
  /** Cheque/trace number for a manual payment. Null otherwise. */
  readonly paymentReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Manual (off-Stripe) payment methods an admin can record when marking a
 * commission invoice paid — cheque, bank draft, e-transfer, cash, a
 * separate card terminal, or anything else.
 */
export type ManualPaymentMethod =
  | 'cheque'
  | 'bank_draft'
  | 'e_transfer'
  | 'cash'
  | 'card_terminal'
  | 'other';

/**
 * POST /api/v1/admin/billing/invoices/{id}/mark-paid — record an
 * off-Stripe payment received by the platform.
 *
 * Only `in_review` and `failed` invoices can be marked paid: a `finalized`
 * invoice owns an in-flight Stripe PaymentIntent that this endpoint cannot
 * cancel, so it is rejected with 409 (mark paid after the charge fails, or
 * refund the charge first).
 */
export interface MarkInvoicePaidRequest {
  readonly paymentMethod: ManualPaymentMethod;
  /** Optional cheque/trace number for the payment. */
  readonly reference?: string;
  /** ISO 8601 datetime WITH timezone offset. Defaults to now. */
  readonly paidAt?: string;
}

/** POST /api/v1/admin/billing/invoices/{id}/mark-paid — result. */
export interface MarkInvoicePaidResponse {
  readonly invoiceId: string;
  readonly status: CommissionInvoiceStatus;
  /** ISO 8601 — when the payment was recorded. */
  readonly paidAt: string;
  readonly paymentMethod: ManualPaymentMethod;
  readonly reference: string | null;
}

/**
 * POST /api/v1/admin/billing/invoices/{id}/commission-rate — override the
 * per-invoice commission rate (default is the configured 1% of the signed
 * contract value, excl. land). Unpaid invoices only.
 */
export interface SetCommissionRateRequest {
  /** Percent, e.g. 1.5 = 1.5%. Must satisfy 0 < rate <= 10. */
  readonly rate: number;
}

/** POST /api/v1/admin/billing/invoices/{id}/commission-rate — result. */
export interface SetCommissionRateResponse {
  readonly invoiceId: string;
  readonly status: CommissionInvoiceStatus;
  /** Effective commission rate after the change, in PERCENT. */
  readonly commissionRatePercent: number;
  readonly contractValueCents: number;
  /** round(contractValueCents * rate) after the override, integer cents. */
  readonly commissionCents: number;
  readonly currency: string;
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

/**
 * POST /api/v1/admin/billing/invoices — admin manually creates a commission
 * invoice for a builder's converted lead. Mirrors the builder-reported
 * contract shape (POST /api/v1/billing/report-contract): leadId, integer
 * cents EXCLUDING land, ISO datetime WITH timezone offset — plus the
 * builder's tenantKey, since the admin picks the builder.
 */
export interface ManualInvoiceRequest {
  /** Builder tenant key (from the builders table). */
  readonly tenantKey: string;
  /**
   * The Feasly lead this contract came from (required — attribution and
   * the invoice are lead-keyed).
   */
  readonly leadId: string;
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
  /** ISO 8601 datetime WITH timezone offset. */
  readonly contractSignedAt: string;
}

/** POST /api/v1/admin/billing/invoices — the created (or idempotently re-found) invoice. */
export interface ManualInvoiceResponse {
  readonly invoiceId: string;
  readonly status: CommissionInvoiceStatus;
  readonly tenantKey: string;
  readonly leadId: string;
  readonly contractValueCents: number;
  readonly commissionCents: number;
  readonly currency: string;
  /** ISO 8601 — end of the builder's review/dispute window. */
  readonly reviewDueAt: string | null;
}
