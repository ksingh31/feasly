/**
 * Billing contracts (billing/02 commission engine).
 *
 * Shapes only: no logic, no math, no secrets. Mirrors the
 * `commission_invoices` / `billing_events` tables and the Stripe webhook
 * route's wire shape.
 */

/**
 * Commission invoice lifecycle — see TECH_PLAN §2.4.
 *
 * `action_required` (#712): the off-session charge needs the builder to
 * confirm it with their bank (3-D Secure / SCA). The invoice waits for the
 * builder (POST /api/v1/billing/invoices/{id}/confirm-payment); it is not a
 * failure and does not count as a dunning retry.
 */
export type CommissionInvoiceStatus =
  | 'draft'
  | 'in_review'
  | 'finalized'
  | 'action_required'
  | 'paid'
  | 'failed'
  | 'disputed'
  | 'void';

/**
 * Normalised result of one off-session charge attempt (#712), whichever
 * payment provider ran it:
 * - `succeeded`: money moved (the webhook settles the invoice `paid`).
 * - `processing`: still in flight — webhook / reconciliation settles it.
 * - `requires_action`: the bank wants the cardholder to confirm (3DS).
 * - `failed`: declined — the invoice moves to `failed` (dunning).
 */
export type ChargeOutcome =
  | 'succeeded'
  | 'processing'
  | 'requires_action'
  | 'failed';

/**
 * Response of POST /api/v1/billing/invoices/{id}/confirm-payment (#712).
 * The builder portal confirms the PaymentIntent on-session with it:
 * `stripe.confirmCardPayment(clientSecret, { payment_method })` for
 * `provider: 'stripe'`, or POST /billing/simulated/authenticate with
 * `paymentIntentId` for `provider: 'simulated'`. The webhook then settles
 * the invoice — the portal never marks it paid itself.
 */
export interface ConfirmInvoicePaymentResponse {
  readonly invoiceId: string;
  readonly paymentIntentId: string;
  /** PaymentIntent client secret — usable only with the publishable key. */
  readonly clientSecret: string;
  /** Saved card the charge used (`pm_…`); absent when unknown. */
  readonly paymentMethodId?: string;
  readonly provider: 'stripe' | 'simulated';
}

export interface CommissionInvoice {
  readonly id: string;
  readonly tenantKey: string;
  readonly attributionId: string;
  readonly leadId: string;
  /**
   * Builder-facing name of the lead this invoice belongs to, resolved
   * server-side so invoice lists don't need a second lookup.
   */
  readonly leadName: string;
  /** Signed construction contract value, integer cents, excl. land. */
  readonly contractValueCents: number;
  /**
   * The pre-tax commission (invoice subtotal), integer cents. With
   * commission-plus-tax pricing (the default) this is
   * round(contractValueCents * effectiveRate).
   */
  readonly commissionCents: number;
  /*
   * Sales tax (#714). The API always sends these; they are optional only so
   * fixtures written before #714 keep compiling. Absent = no tax
   * (subtotal = total = commissionCents).
   */
  /** Pre-tax subtotal, integer cents (same value as `commissionCents`). */
  readonly subtotalCents: number;
  /** Tax rate snapshotted at invoice creation, in PERCENT (5 = 5%). 0 = no tax. */
  readonly taxRatePercent: number;
  /** True when the commission was priced tax-inclusive. */
  readonly taxInclusive: boolean;
  /** Tax amount, integer cents. */
  readonly taxCents: number;
  /** subtotal + tax — the amount charged, integer cents. */
  readonly totalCents: number;
  /** Tax label (e.g. "GST") when the invoice carries tax; null otherwise. */
  readonly taxLabel: string | null;
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
   * Null = no override — the builder's rate at creation applies.
   */
  readonly commissionRateOverride: number | null;
  /**
   * The builder's `commissionRatePercent` snapshotted at invoice creation
   * (billing/08). Null = legacy invoice created before the snapshot —
   * the configured default rate applies.
   */
  readonly commissionRatePercent: number | null;
  /**
   * The rate actually applied to this invoice, in PERCENT:
   * `commissionRateOverride ?? commissionRatePercent ?? configured default`.
   * Computed server-side so every surface displays one consistent figure.
   */
  readonly effectiveRatePercent: number;
  /**
   * Off-Stripe payment method recorded by an admin mark-paid action.
   * Null unless the invoice was manually marked paid.
   */
  readonly manualPaymentMethod: ManualPaymentMethod | null;
  /** Cheque/trace number for a manual payment. Null otherwise. */
  readonly paymentReference: string | null;
  /**
   * Human-readable invoice number (billing/12): `INV-` + zero-padded
   * sequence, min 4 digits (INV-0001, INV-0002, …). Shown in the builder
   * portal.
   */
  readonly invoiceNumber: string;
  /**
   * How this invoice gets paid (billing/12): 'card' = the normal Stripe
   * off-session auto-charge; anything else (cheque, e_transfer,
   * bank_draft) = manual — the invoice-reviewer timer skips it and it
   * sits until staff marks it paid. Snapshot of the builder org's default
   * payment method at creation; changeable per invoice while unpaid.
   */
  readonly paymentMethod: 'card' | ManualPaymentMethod;
  /*
   * Bank chargebacks + dashboard refunds (#719). The API always sends
   * these; optional only so fixtures written before #719 keep compiling.
   */
  /**
   * Bank chargeback state: null/absent = never disputed with the bank;
   * 'open' while Stripe's dispute is live (no further charge attempts).
   * A lost chargeback does not change `status` — ops decides manually
   * whether the commission is re-collected or written off.
   */
  readonly chargebackStatus?: ChargebackStatus | null;
  /*
   * Refunds (#715). The API always sends `refundedCents` and `refundState`;
   * `refunds` is sent on single-invoice reads (detail, PDF source) and
   * omitted on lists. Optional so pre-#715 fixtures keep compiling.
   */
  /** Total refunded (or being refunded) against this invoice, integer cents. */
  readonly refundedCents?: number;
  /** Derived from `refundedCents` vs `totalCents` — not a status. */
  readonly refundState?: InvoiceRefundState;
  /** Refund records, oldest first. Present on single-invoice reads. */
  readonly refunds?: readonly InvoiceRefund[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Bank chargeback state on an invoice (#719): 'open' while Stripe's
 * dispute is live, then the outcome Stripe reported on close.
 */
export type ChargebackStatus = 'open' | ChargebackOutcome;

/** How Stripe closed a chargeback (`charge.dispute.closed`). */
export type ChargebackOutcome = 'won' | 'lost' | 'warning_closed';

/**
 * Refund state of a paid invoice (#715). Derived, never stored: an invoice
 * stays `paid` when refunded — `partially_refunded` / `refunded` only
 * describe how much of the payment went back.
 */
export type InvoiceRefundState = 'none' | 'partially_refunded' | 'refunded';

/** Why an admin refunded an invoice (#715). */
export type InvoiceRefundReason =
  | 'duplicate'
  | 'billing_error'
  | 'deal_fell_through'
  | 'goodwill'
  | 'other';

/**
 * How the money went back (#715): `stripe` = a refund on the card charge;
 * `manual` = an off-Stripe refund (cheque, e-transfer…) recorded with a
 * reference, for invoices that were marked paid by hand.
 */
export type InvoiceRefundMethod = 'stripe' | 'manual';

/**
 * `pending` = claimed, the Stripe call has not confirmed yet; `succeeded`;
 * `failed` = the Stripe call failed and the amount was released.
 */
export type InvoiceRefundStatus = 'pending' | 'succeeded' | 'failed';

/** One refund against a commission invoice (#715). */
export interface InvoiceRefund {
  readonly id: string;
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly reason: InvoiceRefundReason;
  readonly note: string | null;
  readonly method: InvoiceRefundMethod;
  readonly status: InvoiceRefundStatus;
  /** Stripe refund id (`re_…`) for card refunds; null otherwise. */
  readonly stripeRefundId: string | null;
  /** Cheque/trace number for a manual refund; null otherwise. */
  readonly reference: string | null;
  /**
   * The admin who issued the refund. Admin reads only — builder-scoped
   * reads get null.
   */
  readonly actorEmail: string | null;
  readonly createdAt: string;
}

/**
 * POST /api/v1/admin/billing/invoices/{id}/refund — refund a paid invoice
 * in full or in part (#715). Card-paid invoices are refunded on Stripe;
 * manually paid invoices record an off-Stripe refund (`reference`
 * required). Retrying with the same `idempotencyKey` returns the first
 * result and never creates a second refund.
 */
export interface RefundInvoiceRequest {
  /** Integer cents. Omit to refund everything not yet refunded. */
  readonly amountCents?: number;
  readonly reason: InvoiceRefundReason;
  /** Optional context for the audit trail (max 500 chars). */
  readonly note?: string;
  /** Cheque/trace number — required for manually paid invoices. */
  readonly reference?: string;
  /**
   * Client-generated key, one per refund intent (8–100 chars of
   * `A–Z a–z 0–9 _ - :`). A double-click or retry sends the same key.
   */
  readonly idempotencyKey: string;
}

/** POST /api/v1/admin/billing/invoices/{id}/refund — result. */
export interface RefundInvoiceResponse {
  readonly invoiceId: string;
  readonly status: CommissionInvoiceStatus;
  readonly totalCents: number;
  readonly refundedCents: number;
  /** totalCents − refundedCents: what the platform keeps. */
  readonly netCents: number;
  readonly refundState: InvoiceRefundState;
  readonly currency: string;
  readonly refund: InvoiceRefund;
  /** True when this response replays an earlier request with the same key. */
  readonly replayed: boolean;
}

/** Why an admin voided an invoice (#715). */
export type VoidInvoiceReason =
  | 'duplicate'
  | 'created_in_error'
  | 'deal_fell_through'
  | 'other';

/**
 * POST /api/v1/admin/billing/invoices/{id}/void — cancel an invoice that
 * should not be charged (#715). Allowed from `draft`, `in_review` and
 * `failed`; 409 from `finalized` (charge in flight), `paid` (refund
 * instead), `disputed` (use the dispute console) and `void`.
 */
export interface VoidInvoiceRequest {
  readonly reason: VoidInvoiceReason;
  /** Optional context for the audit trail (max 500 chars). */
  readonly note?: string;
}

/** POST /api/v1/admin/billing/invoices/{id}/void — result. */
export interface VoidInvoiceResponse {
  readonly invoiceId: string;
  /** Always `void`. */
  readonly status: CommissionInvoiceStatus;
  /** The status the invoice was voided from. */
  readonly previousStatus: CommissionInvoiceStatus;
}

/**
 * POST /api/v1/admin/billing/invoices/{id}/correct-contract — fix the
 * reported contract on an invoice that has not been charged yet (#715).
 * Allowed from `draft` and `in_review` (409 otherwise). Commission and tax
 * are recalculated at the invoice's own rate and tax snapshot; an
 * `in_review` invoice gets a fresh 7-day review window and the builder is
 * emailed. The original values stay in the audit trail.
 */
export interface CorrectContractRequest {
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
  /** ISO 8601 datetime WITH timezone offset, not in the future. */
  readonly contractSignedAt: string;
  /** Why the contract changed (required, max 500 chars). */
  readonly note: string;
}

/** POST /api/v1/admin/billing/invoices/{id}/correct-contract — result. */
export interface CorrectContractResponse {
  readonly invoiceId: string;
  readonly status: CommissionInvoiceStatus;
  readonly previousContractValueCents: number;
  readonly contractValueCents: number;
  readonly contractSignedAt: string;
  readonly commissionCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly currency: string;
  /** New end of the review window (in_review), null for a draft. */
  readonly reviewDueAt: string | null;
}

/**
 * POST /api/v1/admin/billing/invoices/{id}/reverse-payment — undo a manual
 * mark-paid when the money never arrived (bounced cheque) (#715). The
 * invoice moves `paid → failed`; only manually paid invoices with no
 * refunds qualify (409 otherwise). The payment method stays manual, so
 * nothing is auto-charged.
 */
export interface ReverseManualPaymentRequest {
  /** Why the payment is reversed (required, max 500 chars). */
  readonly reason: string;
}

/** POST /api/v1/admin/billing/invoices/{id}/reverse-payment — result. */
export interface ReverseManualPaymentResponse {
  readonly invoiceId: string;
  /** Always `failed`. */
  readonly status: CommissionInvoiceStatus;
  /** The manual method that was reversed. */
  readonly reversedPaymentMethod: ManualPaymentMethod;
  readonly reversedReference: string | null;
}

/**
 * Manual (off-Stripe) payment methods an admin can record when marking a
 * commission invoice paid — cheque, bank draft, direct deposit, e-transfer,
 * cash, a Visa or Mastercard payment taken outside Stripe, a separate card
 * terminal, or anything else.
 */
export type ManualPaymentMethod =
  | 'cheque'
  | 'bank_draft'
  | 'direct_deposit'
  | 'e_transfer'
  | 'cash'
  | 'visa'
  | 'mastercard'
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
  /** Tax recalculated at the invoice's snapshotted rate (#714), integer cents. */
  readonly taxCents?: number;
  /** commission + tax after the override (#714), integer cents. */
  readonly totalCents?: number;
  readonly currency: string;
}

/** GET /api/v1/billing/commission-rate — the caller's builder org rate. */
export interface CommissionRateResponse {
  /**
   * The builder org's negotiated commission rate, in PERCENT (1 = 1%).
   * Falls back to the configured default when the builder row is missing.
   */
  readonly commissionRatePercent: number;
}

/**
 * Builder-selectable payment methods (billing/12): the card on file, or
 * a manual method (cheque, e-transfer, bank draft). Choosing a manual
 * method pauses the Stripe auto-charge — the invoice sits until staff
 * marks it paid via the admin mark-paid flow.
 */
export type BuilderPaymentMethod = 'card' | 'cheque' | 'e_transfer' | 'bank_draft';

/**
 * GET /api/v1/billing/payment-method — the builder org's default payment
 * method. Every new commission invoice is created with this method (the
 * builder can change it per invoice while the invoice is unpaid).
 */
export interface DefaultPaymentMethodResponse {
  /** 'card' when the builder never chose — the card on file is charged. */
  readonly defaultMethod: BuilderPaymentMethod;
}

/**
 * PUT /api/v1/billing/payment-method — set the builder org's default
 * payment method. Applies to invoices created afterwards; existing
 * invoices keep the method they were created with.
 */
export interface SetDefaultPaymentMethodRequest {
  readonly method: BuilderPaymentMethod;
}

/** PUT /api/v1/billing/payment-method — result. */
export type SetDefaultPaymentMethodResponse = DefaultPaymentMethodResponse;

/**
 * PUT /api/v1/billing/invoices/{id}/payment-method — change the payment
 * method on one invoice. Allowed while the invoice is unpaid (draft,
 * in_review, failed); 409 otherwise. 403 for another tenant's invoice.
 */
export interface SetInvoicePaymentMethodRequest {
  readonly method: BuilderPaymentMethod;
}

/**
 * PUT /api/v1/admin/billing/invoices/{id}/payment-method — an admin
 * changes the planned payment method on one commission invoice.
 *
 * Same rules as the builder endpoint (unpaid invoices only: draft,
 * in_review, failed; 409 otherwise). Choosing a manual method pauses the
 * Stripe auto-charge until staff marks the invoice paid. Admins act
 * across builders, so there is no tenant check — the change is audited
 * with the admin identity.
 */
export interface AdminSetInvoicePaymentMethodResponse {
  readonly invoiceId: string;
  readonly status: CommissionInvoiceStatus;
  readonly paymentMethod: BuilderPaymentMethod;
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
  /**
   * #716: the card's expiry month ends within the configured warning
   * window (BILLING_CARD_EXPIRY_WARNING_DAYS) — show "expires soon".
   */
  readonly expiresSoon?: boolean;
  /** #716: the card's expiry month has ended — it can no longer be charged. */
  readonly expired?: boolean;
}

/** Result of POST /api/v1/billing/setup-intent (billing/02, BILL-02). */
export interface SetupIntentResponse {
  readonly setupIntentId: string;
  readonly clientSecret: string;
  /**
   * #753: which payment provider issued the intent. `simulated` → show the
   * test-card picker (POST /billing/simulated/confirm-setup) instead of
   * Stripe Elements.
   */
  readonly provider?: 'stripe' | 'simulated';
}

/**
 * Dispute console contracts (billing/01 follow-on, was OPS-009).
 *
 * Wire shapes for `/api/v1/admin/disputes/*`. Dates are ISO-8601 strings.
 * The evidence snapshot is immutable server-side: the console renders it,
 * never the live invoice row, so the evidence can't change under review.
 */

/**
 * Dispute lifecycle. Builder disputes: open → accepted | rejected (an admin
 * decides). Chargebacks (#719): open → closed when Stripe reports the
 * outcome — they are resolved in the Stripe dashboard, never in Feasly.
 */
export type DisputeStatus = 'open' | 'accepted' | 'rejected' | 'closed';

/**
 * Who raised a dispute (#719): 'builder' = an invoice dispute raised in the
 * portal; 'chargeback' = a bank dispute of the card charge, from Stripe.
 */
export type DisputeSource = 'builder' | 'chargeback';

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
  /**
   * Invoice status when the dispute opened: 'disputed' for builder
   * disputes; usually 'paid' for chargebacks (#719).
   */
  readonly status: CommissionInvoiceStatus;
  readonly reviewDueAt: string | null;
  readonly disputeReason: string;
  readonly invoiceCreatedAt: string;
  readonly disputedAt: string;
  /** True when backfilled for a disputed invoice with no dispute row. */
  readonly backfilled?: boolean;
  /**
   * The commission rate applied to this invoice (percent, e.g. 1.5),
   * captured at dispute time. Snapshots written before billing/08 lack
   * this field — readers must fall back to 1%.
   */
  readonly effectiveRatePercent?: number;
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
  /*
   * Chargebacks (#719). The API always sends these; optional only so
   * fixtures written before #719 keep compiling. Absent = 'builder'.
   * For a chargeback, slaDueAt is Stripe's evidence deadline.
   */
  readonly source?: DisputeSource;
  /** Stripe dispute id (`dp_…`) — chargebacks only, null otherwise. */
  readonly stripeDisputeId?: string | null;
  /** Stripe reason code (e.g. 'fraudulent') — chargebacks only. */
  readonly stripeReason?: string | null;
  /** Stripe's raw dispute status (needs_response, under_review, won, …). */
  readonly stripeStatus?: string | null;
  /** Disputed amount, integer cents — chargebacks only. */
  readonly amountCents?: number | null;
  /** Stripe's evidence deadline (ISO) — chargebacks only. */
  readonly evidenceDueAt?: string | null;
  /** Whole calendar days until evidenceDueAt (negative when past). */
  readonly evidenceDaysRemaining?: number | null;
  /** Outcome once Stripe closes the chargeback; null while open. */
  readonly outcome?: ChargebackOutcome | null;
  /**
   * True for a Stripe live-mode dispute, false for test mode, null for a
   * builder dispute. The "View in Stripe" link picks the dashboard from it.
   */
  readonly livemode?: boolean | null;
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
  /** Tax amount (#714), integer cents. */
  readonly taxCents?: number;
  /** commission + tax (#714), integer cents. */
  readonly totalCents?: number;
  /** Tax rate snapshotted on the invoice (#764), in PERCENT. 0 = no tax. */
  readonly taxRatePercent?: number;
  /** Tax label (e.g. "GST") when the invoice carries tax (#764); null otherwise. */
  readonly taxLabel?: string | null;
  readonly currency: string;
  /** ISO 8601 — end of the builder's review/dispute window. */
  readonly reviewDueAt: string | null;
}

/**
 * Builder billing plan type — mirrors the server's `BILLING_MODEL`:
 * 'commission' (a percentage of each signed contract, excl. land) or
 * 'flat' (a fixed monthly subscription).
 */
export type BillingPlanType = 'commission' | 'flat';

/** One failed (charge declined) invoice, for the Money page's failed list. */
export interface BillingOverviewFailedInvoice {
  readonly id: string;
  /** Human-readable invoice number, e.g. "INV-0042". */
  readonly invoiceNumber: string;
  readonly leadId: string;
  /** Commission owed on this invoice, integer cents. */
  readonly commissionCents: number;
}

/**
 * The next automatic card charge: the earliest-due in-review invoice whose
 * payment method is the card on file. The invoice-reviewer timer charges
 * it once its 7-day review window ends (`chargeAt`), unless disputed.
 */
export interface BillingOverviewNextCharge {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  /** Amount to be charged (commission + tax, #714), integer cents. */
  readonly amountCents: number;
  /** ISO 8601 — end of the review window, when the charge runs. */
  readonly chargeAt: string;
  /** Last 4 digits of the card on file; null when no card is saved. */
  readonly cardLast4: string | null;
}

/**
 * GET /api/v1/builder/billing/overview — one call powers the builder
 * portal's Money page header. Tenant-scoped to the session's builder org.
 * All money figures are integer cents computed server-side.
 */
export interface BuilderBillingOverviewResponse {
  readonly planType: BillingPlanType;
  /**
   * The builder org's commission rate, in PERCENT (1 = 1%), from tenant
   * config (falls back to the configured default, 1%). Null under 'flat'.
   */
  readonly commissionRatePercent: number | null;
  readonly currency: string;
  /**
   * Sum owed (commission + tax, #714) across unpaid invoices (draft,
   * in_review, finalized, failed), integer cents. Disputed invoices are
   * excluded — their charge clock is frozen until resolved.
   */
  readonly outstandingCents: number;
  /** Number of unpaid invoices included in `outstandingCents`. */
  readonly outstandingCount: number;
  /** Null when no card auto-charge is scheduled. */
  readonly nextCharge: BillingOverviewNextCharge | null;
  readonly failedCount: number;
  /** Failed invoices, newest first. */
  readonly failedInvoices: readonly BillingOverviewFailedInvoice[];
  /** Number of invoices currently disputed (charge clock frozen). */
  readonly disputedCount: number;
  /**
   * Card on file (brand/last4/expiry only — never the PAN). Null under
   * 'flat', where the card lives on the Stripe subscription instead.
   */
  readonly card: CardOnFileStatus | null;
  /**
   * Sales tax applied to NEW commission invoices (#764), for the portal's
   * record-contract preview. Absent when tax is off, under 'flat', or the
   * configured rate is 0. Display-only: invoices carry their own snapshot.
   */
  readonly tax?: BillingTaxPreview;
}

/** Builder-facing view of the configured sales tax (#764). No supplier details. */
export interface BillingTaxPreview {
  /** Tax rate in PERCENT (5 = 5% GST). Always > 0. */
  readonly ratePercent: number;
  /** Label shown next to the tax amount, e.g. "GST". */
  readonly label: string;
  /** true = the commission already includes tax; false = tax is added on top. */
  readonly inclusive: boolean;
}
