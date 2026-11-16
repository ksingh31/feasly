/**
 * Commission engine (billing/02).
 *
 * Implements the 1% commission model (Karan 2026-09-24): a won deal
 * (builder-reported signed contract, via the attribution service) creates
 * exactly one draft invoice; the 7-day review window passes → the engine
 * creates an off-session Stripe PaymentIntent against the saved card;
 * webhooks settle paid/failed. Disputes FREEZE the charge clock and alert
 * ops. Reporting after the 14-day SLA flags the invoice and alerts ops.
 *
 * Charges run through Stripe off-session PaymentIntents — never Stripe
 * Invoices — so review/dispute semantics stay under Feasly's control
 * (TECH_PLAN §2.4). Every state change appends one `billing_events` row.
 *
 * Model gate: all methods throw BILLING_MODEL_MISMATCH (409) when
 * `BILLING_MODEL` is not 'commission' — the flat path lives in
 * flat-plan.service.ts and config selects the active one.
 *
 * Status lifecycle: draft → in_review → finalized → paid
 *                                │          └→ failed (dunning)
 *                                └→ disputed → in_review | void
 * Terminal: paid, failed, void.
 *
 * Admin corrections (#715), outside the charge-path transition map:
 * draft | in_review | failed → void (voidInvoice), paid → failed
 * (reverseManualPayment, manual payments only), contract correction on
 * draft | in_review, and refunds on paid invoices — the invoice stays
 * 'paid'; refundState (partially_refunded / refunded) is derived from
 * refunded_cents. Each writes billing_events + admin_audit_log.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import {
  attributionEvents,
  billingRefunds,
  builderAllowlist,
  builders,
  commissionInvoices,
  leads,
  tenants,
} from '../../db/schema';
import { HttpError, ErrorCodes } from '../../middleware/errors';
import {
  computeCommissionCents,
  effectiveRatePercent,
  formatRatePercent,
  wholeDaysBetween,
} from '../../lib/commission-math';
import { isReportingOnTime } from '../../lib/billing-deadlines';
import { computeInvoiceTax } from '../../lib/tax-math';
import {
  readDefaultPaymentMethod,
  requireKnownPaymentMethod,
} from '../../lib/payment-method';
import type {
  AttributionService,
  AttributionRecord,
} from './attribution.service';
import type { BillingAuditService } from './billing-audit.service';
import type { StripeService } from './stripe.service';
import type { CommissionEmailTax, EmailService } from '../email/email.service';
import { ensureOpsAlertDelivered } from '../ops-alerts.service';
import type { AdminAuditStore } from '../admin-audit.store';
import type {
  InvoiceRefundMethod,
  InvoiceRefundReason,
  InvoiceRefundState,
  InvoiceRefundStatus,
  ManualPaymentMethod,
  VoidInvoiceReason,
} from '@feasly/contracts';
import type { BuilderPaymentMethod } from '@feasly/contracts';

export type CommissionInvoiceStatus =
  | 'draft'
  | 'in_review'
  | 'finalized'
  | 'paid'
  | 'failed'
  | 'disputed'
  | 'void';

export interface CommissionInvoiceRecord {
  readonly id: string;
  readonly tenantKey: string;
  readonly attributionId: string;
  readonly leadId: string;
  /**
   * Builder-facing name of the lead this invoice belongs to, resolved
   * server-side (leads table) so invoice lists don't need a second lookup.
   */
  readonly leadName: string;
  readonly contractValueCents: number;
  /**
   * The pre-tax commission (the invoice subtotal), integer cents. In
   * commission-plus-tax mode this is round(contractValueCents * rate).
   */
  readonly commissionCents: number;
  /** Alias of `commissionCents`: the pre-tax subtotal (#714). */
  readonly subtotalCents: number;
  /** Tax rate snapshotted at creation, in PERCENT. 0 = no tax (#714). */
  readonly taxRatePercent: number;
  /** True when the commission was priced tax-inclusive (#714). */
  readonly taxInclusive: boolean;
  /** Tax amount, integer cents. 0 when the invoice carries no tax. */
  readonly taxCents: number;
  /** subtotal + tax: the amount charged, integer cents (#714). */
  readonly totalCents: number;
  /**
   * Tax label from config (e.g. "GST") when the invoice carries a tax
   * rate; null on untaxed invoices.
   */
  readonly taxLabel: string | null;
  readonly currency: string;
  readonly stripePaymentIntentId: string | null;
  readonly status: CommissionInvoiceStatus;
  readonly reviewDueAt: Date | null;
  readonly finalizedAt: Date | null;
  readonly paidAt: Date | null;
  readonly slaBreached: boolean;
  readonly disputeReason: string | null;
  /** Off-session charge retry attempts made (BILL-03). */
  readonly retryCount: number;
  /**
   * Admin override of the commission rate, in PERCENT. Null = no override —
   * the builder's rate at creation applies.
   */
  readonly commissionRateOverride: number | null;
  /**
   * The builder's `commissionRatePercent` snapshotted at invoice creation
   * (billing/08). Null = legacy invoice created before the snapshot.
   */
  readonly commissionRatePercent: number | null;
  /**
   * The rate actually applied to this invoice, in PERCENT:
   * `commissionRateOverride ?? commissionRatePercent ?? configured default`.
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
   * sequence, min 4 digits. Shown in the builder portal.
   */
  readonly invoiceNumber: string;
  /**
   * How this invoice gets paid (billing/12): 'card' = the normal Stripe
   * off-session auto-charge; cheque/e_transfer/bank_draft = manual — the
   * invoice-reviewer timer skips it until staff marks it paid. Snapshot
   * of the builder org's default payment method at creation; changeable
   * per invoice while the invoice is unpaid.
   */
  readonly paymentMethod: BuilderPaymentMethod;
  /**
   * #715: integer cents refunded (or claimed by an in-flight refund)
   * against this invoice. 0 when never refunded.
   */
  readonly refundedCents: number;
  /** #715: derived from refundedCents vs totalCents — not a status. */
  readonly refundState: InvoiceRefundState;
  /**
   * #715: refund records, oldest first. Loaded on single-invoice reads
   * (getById and the admin money actions); omitted on lists.
   */
  readonly refunds?: readonly InvoiceRefundRecord[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One refund against a commission invoice (#715). */
export interface InvoiceRefundRecord {
  readonly id: string;
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly reason: InvoiceRefundReason;
  readonly note: string | null;
  readonly method: InvoiceRefundMethod;
  readonly status: InvoiceRefundStatus;
  readonly stripeRefundId: string | null;
  readonly reference: string | null;
  /** The admin who issued it. Builder-scoped reads null this out. */
  readonly actorEmail: string | null;
  readonly createdAt: Date;
}

/** Refund reasons accepted by `refundInvoice` (#715). */
export const INVOICE_REFUND_REASONS: ReadonlyArray<InvoiceRefundReason> = [
  'duplicate',
  'billing_error',
  'deal_fell_through',
  'goodwill',
  'other',
];

/** Void reasons accepted by `voidInvoice` (#715). */
export const VOID_INVOICE_REASONS: ReadonlyArray<VoidInvoiceReason> = [
  'duplicate',
  'created_in_error',
  'deal_fell_through',
  'other',
];

export interface RefundInvoiceInput {
  /** Integer cents; omit to refund everything not yet refunded. */
  readonly amountCents?: number;
  readonly reason: InvoiceRefundReason;
  readonly note?: string;
  /** Cheque/trace number — required for manually paid invoices. */
  readonly reference?: string;
  /** Client key, one per refund intent: retries replay, never re-refund. */
  readonly idempotencyKey: string;
  readonly adminEmail: string | null;
}

export interface RefundInvoiceResult {
  readonly invoice: CommissionInvoiceRecord;
  readonly refund: InvoiceRefundRecord;
  /** True when an earlier request with the same key produced this refund. */
  readonly replayed: boolean;
}

export interface VoidInvoiceInput {
  readonly reason: VoidInvoiceReason;
  readonly note?: string;
  readonly adminEmail: string | null;
}

export interface CorrectContractInput {
  /** Integer cents, EXCLUDING land. */
  readonly contractValueCents: number;
  readonly contractSignedAt: Date;
  /** Why the contract changed — required for the audit trail. */
  readonly note: string;
  readonly adminEmail: string | null;
}

export interface CorrectContractResult {
  readonly invoice: CommissionInvoiceRecord;
  readonly previousContractValueCents: number;
  readonly contractSignedAt: Date;
}

export interface ReverseManualPaymentInput {
  /** Why the payment is reversed (e.g. "cheque returned NSF"). Required. */
  readonly reason: string;
  readonly adminEmail: string | null;
}

export interface ReverseManualPaymentResult {
  readonly invoice: CommissionInvoiceRecord;
  readonly reversedPaymentMethod: ManualPaymentMethod;
  readonly reversedReference: string | null;
}

/** Off-Stripe payment methods accepted by `markPaidManually`. */
export const MANUAL_PAYMENT_METHODS: ReadonlyArray<ManualPaymentMethod> = [
  'cheque',
  'bank_draft',
  'direct_deposit',
  'e_transfer',
  'cash',
  'visa',
  'mastercard',
  'card_terminal',
  'other',
];

/**
 * Builder-selectable payment methods (billing/12): the card on file, or
 * a manual method (cheque, e-transfer, bank draft). Lives in
 * `src/lib/payment-method.ts` (shared with the builder service);
 * re-exported here so existing importers keep working.
 */
export { BUILDER_PAYMENT_METHODS } from '../../lib/payment-method';

export interface ManualPaymentInput {
  readonly paymentMethod: ManualPaymentMethod;
  /** Optional cheque/trace number. */
  readonly reference?: string;
  /** When the payment was received. Defaults to now. */
  readonly paidAt?: Date;
  /** The admin who recorded the payment (audit trail). */
  readonly adminEmail: string | null;
}

/**
 * Who settled a PaymentIntent outcome (#711): the Stripe webhook (default)
 * or the daily reconciliation pass reading the PaymentIntent from Stripe.
 * Recorded as `source` in the settlement audit row.
 */
export type SettlementSource = 'webhook' | 'reconciliation';

export interface SettlementOptions {
  readonly source?: SettlementSource;
}

export interface CommissionService {
  /**
   * Won deal → draft invoice. Reads the reported contract from the
   * attribution service; exactly one invoice per attribution (UNIQUE
   * backstop, migration 0033). Idempotent: if an invoice already exists
   * for the attribution (retried won event, or a lost insert race), the
   * existing invoice is returned — never a duplicate, never a 409.
   * Flags + alerts when the report arrived after the 14-day SLA.
   */
  createDraftInvoice(attributionId: string): Promise<CommissionInvoiceRecord>;
  /** Move a draft into the 7-day review window. */
  submitForReview(invoiceId: string): Promise<CommissionInvoiceRecord>;
  /**
   * Finalize a passed review: create the off-session PaymentIntent against
   * the tenant's saved card (idempotency key
   * `feasly:commission_invoices:{id}:charge`).
   */
  finalizeInvoice(invoiceId: string): Promise<CommissionInvoiceRecord>;
  /**
   * Retry a failed charge (BILL-03): creates a NEW off-session PaymentIntent
   * against the tenant's saved card (idempotency key
   * `feasly:commission_invoices:{id}:retry:{n}`) and moves the invoice
   * `failed → finalized`, where the existing webhook path settles
   * paid/failed. Allowed from 'failed' only (409 otherwise — disputed can
   * never be retried); capped by BILLING_MAX_CHARGE_RETRIES (422 past the
   * cap). The 7-day review window is NOT reopened on retry.
   */
  retryCharge(invoiceId: string): Promise<CommissionInvoiceRecord>;
  /** Builder disputes — charge clock FROZEN, ops alerted. */
  disputeInvoice(invoiceId: string, reason: string): Promise<CommissionInvoiceRecord>;
  /** Human resolution of a dispute: back to review or void. */
  resolveDispute(
    invoiceId: string,
    outcome: 'resume' | 'void',
  ): Promise<CommissionInvoiceRecord>;
  /**
   * Webhook: payment_intent.succeeded. No-op (audited) while the invoice is
   * 'disputed' — the dispute freeze holds against webhooks.
   */
  markPaidByPaymentIntent(
    paymentIntentId: string,
    options?: SettlementOptions,
  ): Promise<CommissionInvoiceRecord>;
  /**
   * Admin manually marks an invoice paid for an off-Stripe payment
   * (cheque, bank draft, e-transfer, cash, separate card terminal…).
   *
   * Allowed from 'in_review' (the common case: the builder paid another
   * way before the 7-day window ended), 'finalized' (a charge was
   * attempted but the money arrived off-Stripe), and 'failed' (dunning
   * resolved by hand). Never from 'disputed' — the dispute freeze holds
   * until a human resolves it — and never from 'paid'/'void' (409).
   *
   * CRITICAL: moving the invoice to 'paid' cancels the scheduled
   * auto-charge. The invoice-reviewer timer only finalizes 'in_review'
   * rows (findDueReviews), so a paid invoice can never be charged by
   * Stripe afterwards; a late payment_intent.succeeded webhook no-ops on
   * the terminal status (markPaidByPaymentIntent). reviewDueAt is cleared
   * so no charge clock remains.
   */
  markPaidManually(
    invoiceId: string,
    input: ManualPaymentInput,
  ): Promise<CommissionInvoiceRecord>;
  /**
   * Admin overrides the per-invoice commission rate (percent, e.g. 1.5 =
   * 1.5%) and recalculates `commissionCents = round(contractValueCents *
   * rate)`. Allowed only on unpaid, undisputed invoices (draft, in_review,
   * failed) — a disputed or settled invoice is never silently repriced
   * (409), and 'finalized' is blocked too because a PaymentIntent already
   * exists for the old amount. Validates 0 < rate <= 10 (400 otherwise).
   */
  setCommissionRate(
    invoiceId: string,
    ratePercent: number,
    adminEmail: string | null,
  ): Promise<CommissionInvoiceRecord>;
  /**
   * Webhook: payment_intent.payment_failed → dunning. No-op (audited) while
   * the invoice is 'disputed'. The optional failure reason is recorded in
   * the audit payload so the dunning queue can show it (BILL-03).
   */
  markFailedByPaymentIntent(
    paymentIntentId: string,
    failureReason?: string,
    options?: SettlementOptions,
  ): Promise<CommissionInvoiceRecord>;
  /** In-review invoices whose review window has passed (timer input). */
  findDueReviews(now: Date): Promise<CommissionInvoiceRecord[]>;
  /**
   * #711 reconciliation input: 'finalized' invoices (charge in progress)
   * that entered 'finalized' at or before `cutoff` and carry a
   * PaymentIntent — the webhook that should have settled them never landed.
   */
  findAwaitingSettlement(cutoff: Date): Promise<CommissionInvoiceRecord[]>;
  /**
   * In-review invoices whose review window has passed BUT whose
   * paymentMethod is manual (billing/12) — the timer must skip these
   * (no auto-charge, no card retry) until staff marks them paid.
   * Returned for observability: the reviewer's `skipped` count.
   */
  countSkippedManualReviews(now: Date): Promise<number>;
  /**
   * The invoice for an attribution, or null. Used by the billing won-flow
   * for idempotency: one attribution yields exactly one invoice.
   */
  findByAttribution(attributionId: string): Promise<CommissionInvoiceRecord | null>;
  /**
   * The invoice for a lead, or null. The won-flow checks this FIRST —
   * before recording a new introduction — so a retried won event can never
   * mint a second invoice for the same lead.
   */
  findByLead(leadId: string): Promise<CommissionInvoiceRecord | null>;
  getById(invoiceId: string): Promise<CommissionInvoiceRecord>;
  /**
   * The builder org's negotiated commission rate, in PERCENT (billing/08).
   * Falls back to the configured default (`billing.commissionRate`) when
   * the builder row is missing — a builder can always be billed.
   */
  getCommissionRatePercent(tenantKey: string): Promise<number>;
  /**
   * The builder org's default payment method (billing/12), read from the
   * `builders.settings` escape hatch (`defaultPaymentMethod`). 'card'
   * when unset or when the builder row is missing — the card on file is
   * charged.
   */
  getDefaultPaymentMethod(tenantKey: string): Promise<BuilderPaymentMethod>;
  /**
   * Set the builder org's default payment method (billing/12), merged
   * into `builders.settings` — no migration, that's what the hatch is
   * for. Applies to invoices created afterwards; existing invoices keep
   * the method they were created with. 400 on an unknown method, 404
   * when the builder row is missing. Audited.
   */
  setDefaultPaymentMethod(
    tenantKey: string,
    method: BuilderPaymentMethod,
  ): Promise<BuilderPaymentMethod>;
  /**
   * Change the payment method on one invoice (billing/12). Allowed on every
   * unpaid invoice (draft, in_review, failed, finalized) — 409 otherwise
   * (paid, void, disputed). 403 when the invoice belongs to a different
   * tenant, 404 when the invoice is unknown, 400 on an unknown method.
   * On a finalized invoice the in-flight Stripe PaymentIntent is not
   * cancelled — it resolves via webhook; the new method governs what
   * happens next. Switching to a manual method pauses the Stripe
   * auto-charge (the invoice-reviewer timer skips non-card invoices);
   * switching back to 'card' re-arms it. Audited old → new in
   * `billing_events`.
   */
  setInvoicePaymentMethod(
    tenantKey: string,
    invoiceId: string,
    method: BuilderPaymentMethod,
  ): Promise<CommissionInvoiceRecord>;
  /**
   * BILL-04: paginated invoice list, newest first. Builders pass their
   * tenantKey (scoped); admins pass null (all tenants).
   *
   * `invoiceNumber` is an optional case-insensitive partial match on the
   * human-readable invoice number (e.g. "42" matches "INV-0042") — powers
   * the builder portal's invoice-number search.
   *
   * `status` optionally restricts to the given invoice statuses (dashboard
   * due-invoice banners: failed + in_review).
   */
  listInvoices(
    tenantKey: string | null,
    opts: {
      limit: number;
      offset: number;
      invoiceNumber?: string;
      status?: string[];
    },
  ): Promise<CommissionInvoiceRecord[]>;
  /**
   * #715: admin refunds a PAID invoice, in full (amount omitted = whatever
   * is not yet refunded) or in part. Card-paid invoices are refunded on
   * the payment provider (idempotency key
   * `feasly:commission_invoices:{id}:refund:{idempotencyKey}`); manually
   * paid invoices record an off-Stripe refund and require a reference.
   *
   * - 409 unless the invoice is 'paid'.
   * - 422 when the amount exceeds what is left to refund (including a
   *   third refund after the invoice was fully refunded).
   * - Idempotent on `idempotencyKey`: a repeat returns the first result
   *   (`replayed: true`) and never creates a second refund. A refund left
   *   'pending' by a transient provider error is resumed with the same
   *   provider idempotency key.
   *
   * The invoice stays 'paid'; `refundState` shows partially_refunded /
   * refunded. Writes billing_events + admin_audit_log.
   */
  refundInvoice(
    invoiceId: string,
    input: RefundInvoiceInput,
  ): Promise<RefundInvoiceResult>;
  /**
   * #715: admin cancels an invoice that must not be charged. Allowed from
   * 'draft', 'in_review' and 'failed'; 409 from 'finalized' (a charge is in
   * flight), 'paid' (refund instead), 'disputed' (dispute console) and
   * 'void'. The review clock is cleared; the reviewer timer and retries
   * only touch in_review / failed rows, so a void invoice is never charged.
   */
  voidInvoice(
    invoiceId: string,
    input: VoidInvoiceInput,
  ): Promise<{ invoice: CommissionInvoiceRecord; previousStatus: CommissionInvoiceStatus }>;
  /**
   * #715: admin corrects the reported contract on an invoice that has not
   * been charged ('draft' or 'in_review'; 409 otherwise). Commission and
   * tax are recalculated at the invoice's effective rate and tax snapshot;
   * the attribution's reported contract is updated to match. An
   * 'in_review' invoice gets a fresh review window and the builder gets
   * the invoice-ready email again. Old values stay in billing_events.
   */
  correctContract(
    invoiceId: string,
    input: CorrectContractInput,
  ): Promise<CorrectContractResult>;
  /**
   * #715: reverse a manual mark-paid (bounced cheque): 'paid' → 'failed'
   * with a mandatory reason. Only invoices marked paid by hand and with no
   * refunds qualify (409 otherwise). The planned payment method is kept,
   * so a manual-method invoice stays paused for card charges.
   */
  reverseManualPayment(
    invoiceId: string,
    input: ReverseManualPaymentInput,
  ): Promise<ReverseManualPaymentResult>;
}

export interface CommissionServiceDeps {
  readonly db: AppDb;
  readonly billing: BillingConfig;
  readonly attribution: AttributionService;
  readonly audit: BillingAuditService;
  readonly stripe: StripeService;
  readonly email: EmailService;
  /** Ops inbox for dispute + SLA-breach + dunning alerts. */
  readonly opsInbox: string;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
  /** Defaults to node:crypto randomUUID; tests inject a fixed id. */
  readonly newId?: () => string;
  /** Review window length in days (7). Configurable for tests. */
  readonly reviewWindowDays?: number;
  /** Warning sink for accepted-but-unconfirmed ops alerts. Defaults to console.warn. */
  readonly logWarning?: (message: string) => void;
  /**
   * #715: admin_audit_log sink for admin money actions (refund, void,
   * contract correction, payment reversal). Optional so engine-only
   * callers and tests need not wire it.
   */
  readonly adminAudit?: Pick<AdminAuditStore, 'log'>;
}

const TERMINAL_STATUSES: ReadonlySet<CommissionInvoiceStatus> = new Set([
  'paid',
  'failed',
  'void',
]);

/**
 * Legal invoice state transitions (P0, 2026-09-27: dispute-vs-charge race).
 *
 * The charge clock FREEZES while an invoice is 'disputed': only the
 * dispute-resolution flow (resolveDispute, or dispute.service's post-refund
 * paid→void) may move an invoice out of 'disputed'. In particular
 * disputed→paid/finalized/failed is never legal — a Stripe webhook arriving
 * mid-dispute must not silently un-freeze the charge.
 *
 * transition() enforces this map AND performs the UPDATE conditionally on
 * the expected current status, so a lost check-then-act race surfaces as a
 * 409 instead of silently overwriting a concurrent transition (e.g.
 * disputeInvoice racing finalizeInvoice).
 */
const ALLOWED_TRANSITIONS: Record<
  CommissionInvoiceStatus,
  ReadonlySet<CommissionInvoiceStatus>
> = {
  draft: new Set(['in_review']),
  // in_review → paid: admin mark-paid for an off-Stripe payment received
  // before the 7-day window closed. Moving to 'paid' cancels the scheduled
  // auto-charge (findDueReviews only touches 'in_review').
  in_review: new Set(['finalized', 'disputed', 'paid']),
  finalized: new Set(['paid', 'failed']),
  paid: new Set([]),
  // BILL-03: a failed invoice may be re-charged by an admin (retryCharge),
  // moving to `finalized` with a fresh PaymentIntent. `finalized` (not
  // `in_review`) is deliberate: the webhook settles `finalized → paid` /
  // `finalized → failed` via the EXISTING path (no new transitions), the
  // review window is NOT reopened (the builder already had 7 days), and the
  // invoice-reviewer timer only touches `in_review`, so no second charge
  // can be created while the retry PI is pending. The story's literal
  // `failed → in_review` text was corrected here: `in_review → paid` is not
  // a legal transition, so the retry PI's success webhook would have 409'd.
  //
  // failed → paid: admin mark-paid when dunning is resolved by hand
  // (off-Stripe payment after a card decline). Dunning ends — the invoice
  // leaves the failed state, so no retry can charge it afterwards.
  failed: new Set(['finalized', 'paid']),
  disputed: new Set(['in_review', 'void']),
  void: new Set([]),
};

import { isUniqueViolation } from './pg-errors';

/**
 * Escapes the LIKE wildcards (`%`, `_`, and the escape char itself) so a
 * user-supplied invoice-number search is a literal substring match —
 * "%" in the input can't widen the match.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * billing/12 + Karan (2026-10-01): choosing a manual payment method pauses
 * the Stripe auto-charge. Every charge path must refuse non-card invoices —
 * charging a card after staff deliberately switched an invoice to manual
 * risks double-collection (e.g. cheque + card).
 */
function requireCardPaymentMethod(
  invoiceId: string,
  paymentMethod: string,
): void {
  if (paymentMethod === 'card') {
    return;
  }
  throw new HttpError(
    409,
    ErrorCodes.CONFLICT,
    `Invoice "${invoiceId}" is on manual payment (${paymentMethod}) — ` +
      'card charges are paused. Mark it paid once the payment arrives.',
  );
}

/**
 * The amount charged for an invoice (#714): the snapshotted total, or
 * commission + tax for a row the 0051 backfill has not reached yet.
 */
export function invoiceTotalCents(
  row: Pick<
    typeof commissionInvoices.$inferSelect,
    'totalCents' | 'commissionCents' | 'taxCents'
  >,
): number {
  return row.totalCents ?? row.commissionCents + row.taxCents;
}

/**
 * Commission → stored invoice figures (#714). `grossCommissionCents` is
 * round(contract × rate); the stored `commission_cents` is the pre-tax
 * subtotal, which differs from it only in tax-inclusive mode.
 */
function invoiceAmounts(
  grossCommissionCents: number,
  taxRatePercent: number,
  taxInclusive: boolean,
): { commissionCents: number; taxCents: number; totalCents: number } {
  const tax = computeInvoiceTax(
    grossCommissionCents,
    taxRatePercent,
    taxInclusive,
  );
  return {
    commissionCents: tax.subtotalCents,
    taxCents: tax.taxCents,
    totalCents: tax.totalCents,
  };
}

/** #715: refund state derived from the refunded total — never stored. */
export function refundStateOf(
  refundedCents: number,
  totalCents: number,
): InvoiceRefundState {
  if (refundedCents <= 0) return 'none';
  return refundedCents >= totalCents ? 'refunded' : 'partially_refunded';
}

function toRefundRecord(
  row: typeof billingRefunds.$inferSelect,
): InvoiceRefundRecord {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    amountCents: row.amountCents,
    currency: row.currency,
    reason: row.reason as InvoiceRefundReason,
    note: row.note,
    method: row.method as InvoiceRefundMethod,
    status: row.status as InvoiceRefundStatus,
    stripeRefundId: row.stripeRefundId,
    reference: row.reference,
    actorEmail: row.actorEmail,
    createdAt: row.createdAt,
  };
}

/**
 * #715: a provider error that definitely created no refund (a 4xx: bad
 * amount, nothing left to refund, unknown PaymentIntent). Anything else —
 * network errors, 5xx — may have reached the provider, so the refund stays
 * 'pending' and a retry with the same key resumes it.
 */
function isDefinitiveRefundRejection(error: unknown): boolean {
  if (error instanceof HttpError) return error.status < 500;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

/** Trimmed optional free text, or null when blank. */
function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toRecord(
  row: typeof commissionInvoices.$inferSelect,
  leadName: string,
  defaultRate: number,
  taxLabel: string | null,
  refunds?: readonly InvoiceRefundRecord[],
): CommissionInvoiceRecord {
  return {
    id: row.id,
    tenantKey: row.tenantKey,
    attributionId: row.attributionId,
    leadId: row.leadId,
    leadName,
    contractValueCents: row.contractValueCents,
    commissionCents: row.commissionCents,
    subtotalCents: row.commissionCents,
    taxRatePercent: row.taxRatePercent,
    taxInclusive: row.taxInclusive,
    taxCents: row.taxCents,
    totalCents: invoiceTotalCents(row),
    taxLabel: row.taxRatePercent > 0 ? taxLabel : null,
    currency: row.currency,
    stripePaymentIntentId: row.stripePaymentIntentId,
    status: row.status as CommissionInvoiceStatus,
    reviewDueAt: row.reviewDueAt,
    finalizedAt: row.finalizedAt,
    paidAt: row.paidAt,
    slaBreached: row.slaBreached,
    disputeReason: row.disputeReason,
    retryCount: row.retryCount,
    commissionRateOverride: row.commissionRateOverride,
    commissionRatePercent: row.commissionRatePercent,
    effectiveRatePercent: effectiveRatePercent(row, defaultRate),
    manualPaymentMethod: row.manualPaymentMethod as ManualPaymentMethod | null,
    paymentReference: row.paymentReference,
    invoiceNumber: row.invoiceNumber,
    paymentMethod: row.paymentMethod as BuilderPaymentMethod,
    refundedCents: row.refundedCents,
    refundState: refundStateOf(row.refundedCents, invoiceTotalCents(row)),
    ...(refunds !== undefined ? { refunds } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Resolve builder-facing lead names for a set of lead ids in a single
 * query. Every commission invoice is created from a lead, so a missing
 * entry is a data-integrity issue — it maps to '' rather than a fake name.
 */
async function leadNamesById(
  db: AppDb,
  leadIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(leadIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db.query.leads.findMany({
    where: inArray(leads.id, unique),
    columns: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Single-lead variant for the non-list invoice paths. */
async function leadNameFor(db: AppDb, leadId: string): Promise<string> {
  return (await leadNamesById(db, [leadId])).get(leadId) ?? '';
}

/**
 * The builder org's negotiated commission rate (PERCENT), or null when the
 * builder row is missing (legacy tenant) — callers fall back to the
 * configured default. Null is never a valid rate; the column is NOT NULL.
 */
async function builderRatePercentFor(
  db: AppDb,
  tenantKey: string,
): Promise<number | null> {
  const row = await db.query.builders.findFirst({
    columns: { commissionRatePercent: true },
    where: eq(builders.tenantKey, tenantKey),
  });
  return row?.commissionRatePercent ?? null;
}

/**
 * The builder org's default payment method (billing/12), from
 * `builders.settings.defaultPaymentMethod`. 'card' when unset, unknown,
 * or the builder row is missing — the card on file is charged.
 */
async function builderDefaultPaymentMethodFor(
  db: AppDb,
  tenantKey: string,
): Promise<BuilderPaymentMethod> {
  const row = await db.query.builders.findFirst({
    columns: { settings: true },
    where: eq(builders.tenantKey, tenantKey),
  });
  return readDefaultPaymentMethod(row?.settings);
}

/**
 * Next human-readable invoice number (billing/12): `INV-` + the
 * `commission_invoice_number_seq` value, zero-padded to min 4 digits.
 * The sequence hands out distinct numbers across concurrent creators;
 * the UNIQUE constraint on `invoice_number` is the backstop.
 */
async function nextInvoiceNumber(db: AppDb): Promise<string> {
  const result = (await db.execute(
    sql`SELECT nextval('commission_invoice_number_seq') AS "n"`,
  )) as unknown;
  // node-postgres returns { rows: [...] }; other drivers may return the
  // rows array directly. int8 arrives as string (pg) or number/bigint.
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown }).rows;
  const first = (Array.isArray(rows) ? rows[0] : undefined) as
    | { n?: unknown }
    | undefined;
  const n = Number(first?.n);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      'commission_invoice_number_seq returned an invalid value',
    );
  }
  return `INV-${String(n).padStart(4, '0')}`;
}

export function createCommissionService(
  deps: CommissionServiceDeps,
): CommissionService {
  const { db, billing, attribution, audit, stripe, email } = deps;
  const now = deps.now ?? (() => new Date());
  const logWarning =
    deps.logWarning ?? ((message: string) => console.warn(message));
  const newId = deps.newId ?? randomUUID;
  const reviewWindowDays = deps.reviewWindowDays ?? 7;
  // #714: tax applies to NEW invoices only when enabled; the rate and mode
  // are snapshotted on the row, so later config changes never reprice.
  const taxConfig = billing.tax;
  const taxLabel = taxConfig?.label ?? null;

  function requireCommissionModel(): void {
    if (billing.model !== 'commission') {
      throw new HttpError(
        409,
        ErrorCodes.BILLING_MODEL_MISMATCH,
        `Commission billing is disabled: BILLING_MODEL='${billing.model}'`,
      );
    }
  }

  async function requireInvoice(
    id: string,
  ): Promise<typeof commissionInvoices.$inferSelect> {
    const row = await db.query.commissionInvoices.findFirst({
      where: eq(commissionInvoices.id, id),
    });
    if (row === undefined) {
      throw new HttpError(
        404,
        ErrorCodes.NOT_FOUND,
        `Commission invoice not found: "${id}"`,
      );
    }
    return row;
  }

  /**
   * Move an invoice from one status to another, atomically.
   *
   * Two guards: (1) the transition must be in ALLOWED_TRANSITIONS —
   * illegal moves (notably anything out of 'disputed' except via the
   * dispute-resolution flow) throw 409; (2) the UPDATE is conditional on
   * the expected current status, so a concurrent transition that landed
   * first surfaces as 409 "changed concurrently" instead of silently
   * overwriting it.
   */
  async function transition(
    id: string,
    from: CommissionInvoiceStatus,
    to: CommissionInvoiceStatus,
    patch: Partial<typeof commissionInvoices.$inferInsert>,
    eventType: string,
    eventPayload?: Record<string, unknown>,
  ): Promise<CommissionInvoiceRecord> {
    if (!ALLOWED_TRANSITIONS[from].has(to)) {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        `Invoice "${id}" cannot move '${from}' → '${to}' — illegal transition`,
      );
    }
    const [updated] = await db
      .update(commissionInvoices)
      .set({ ...patch, status: to, updatedAt: now() })
      .where(
        and(
          eq(commissionInvoices.id, id),
          eq(commissionInvoices.status, from),
        ),
      )
      .returning();
    if (updated === undefined) {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        `Invoice "${id}" changed concurrently — expected '${from}'`,
      );
    }
    const record = toRecord(updated, await leadNameFor(db, updated.leadId), billing.commissionRate, taxLabel);
    await audit.append({
      tenantKey: record.tenantKey,
      eventType,
      entityType: 'commission_invoice',
      entityId: record.id,
      payload: {
        status: to,
        commissionCents: record.commissionCents,
        ...(record.taxCents > 0
          ? { taxCents: record.taxCents, totalCents: record.totalCents }
          : {}),
        ...eventPayload,
      },
    });
    return record;
  }

  async function alertOps(title: string, summary: string): Promise<void> {
    const delivery = await email.sendOpsAlert({
      to: deps.opsInbox,
      title,
      summary,
      firedAt: now(),
    });
    // Accepted-but-unconfirmed counts as sent (issue #573): a retry of the
    // caller would re-send a likely-delivered alert. Only never-accepted
    // sends throw.
    ensureOpsAlertDelivered(delivery, title, logWarning);
  }

  /**
   * BILL-04: resolve the builder's billing contact email for a tenant.
   *
   * Resolution order (first non-empty wins):
   *   1. `builders.email` — the tenant contact email (admin-managed).
   *   2. `tenants.fallback_email` — the embed fallback contact.
   *   3. `builder_allowlist` sign-in email for the tenant.
   * Returns null when none exists — the caller audits the skip instead
   * of failing.
   */
  async function resolveBuilderEmail(tenantKey: string): Promise<string | null> {
    const builder = await db.query.builders.findFirst({
      where: eq(builders.tenantKey, tenantKey),
      columns: { email: true },
    });
    if (builder?.email) return builder.email;
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.tenantKey, tenantKey),
      columns: { fallbackEmail: true },
    });
    if (tenant?.fallbackEmail) return tenant.fallbackEmail;
    const allowlisted = await db.query.builderAllowlist.findFirst({
      where: eq(builderAllowlist.tenantKey, tenantKey),
      columns: { email: true },
    });
    return allowlisted?.email ?? null;
  }

  /**
   * #714: the tax block for builder emails. Omitted entirely on untaxed
   * invoices so their emails match the pre-tax output byte for byte.
   */
  function emailTax(
    invoice: CommissionInvoiceRecord,
  ): { tax?: CommissionEmailTax } {
    if (invoice.taxRatePercent <= 0 || taxConfig === undefined) return {};
    return {
      tax: {
        label: taxConfig.label,
        ratePercent: invoice.taxRatePercent,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
        registrationNumber: taxConfig.registrationNumber,
      },
    };
  }

  /**
   * BILL-04: send a builder billing notification. Never throws — a failed
   * notification is audited (the invoice transition already happened; the
   * email is a notice, not the state change). No PII in the audit payload
   * beyond the fact of the send.
   */
  async function notifyBuilder(
    invoice: CommissionInvoiceRecord,
    kind: 'invoice_ready' | 'payment_received' | 'payment_failed',
  ): Promise<void> {
    const to = await resolveBuilderEmail(invoice.tenantKey);
    // Short public reference: first 8 of the uuid (stable, non-sensitive).
    const invoiceRef = invoice.id.slice(0, 8);
    if (to === null) {
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'invoice.email_skipped_no_contact',
        entityType: 'commission_invoice',
        entityId: invoice.id,
        payload: { kind },
      });
      return;
    }
    let delivery;
    if (kind === 'invoice_ready') {
      if (!invoice.reviewDueAt) return;
      delivery = await email.sendCommissionInvoiceReady({
        to,
        invoiceRef,
        commissionCents: invoice.commissionCents,
        contractValueCents: invoice.contractValueCents,
        currency: invoice.currency,
        commissionRatePercent: invoice.effectiveRatePercent,
        reviewDueAt: invoice.reviewDueAt,
        ...emailTax(invoice),
      });
    } else if (kind === 'payment_received') {
      if (!invoice.paidAt) return;
      delivery = await email.sendCommissionPaymentReceived({
        to,
        invoiceRef,
        commissionCents: invoice.commissionCents,
        currency: invoice.currency,
        paidAt: invoice.paidAt,
        ...emailTax(invoice),
      });
    } else {
      delivery = await email.sendCommissionPaymentFailed({
        to,
        invoiceRef,
        commissionCents: invoice.commissionCents,
        currency: invoice.currency,
        updateWithinDays: 7,
        ...emailTax(invoice),
      });
    }
    await audit.append({
      tenantKey: invoice.tenantKey,
      eventType: delivery.sent
        ? 'invoice.email_sent'
        : 'invoice.email_failed',
      entityType: 'commission_invoice',
      entityId: invoice.id,
      payload: {
        kind,
        ...(delivery.sent ? {} : { failureReason: delivery.failureReason }),
      },
    });
  }

  /**
   * Dispute freeze (P0, 2026-09-27): while an invoice is 'disputed', NO
   * charge-path movement may touch it — not paid, not failed. A Stripe
   * webhook arriving mid-dispute returns the unchanged invoice after
   * writing an audit trail (audited, not silent: a charge attempt against
   * a frozen invoice is an anomaly). Only the dispute-resolution flow
   * (resolveDispute, or dispute.service's post-refund paid→void) may move
   * an invoice out of 'disputed'.
   *
   * Returns the frozen record when frozen, null when the caller may proceed.
   */
  async function frozenDispute(
    row: typeof commissionInvoices.$inferSelect,
    paymentIntentId: string,
    attempted: 'paid' | 'failed',
  ): Promise<CommissionInvoiceRecord | null> {
    if (row.status !== 'disputed') return null;
    await audit.append({
      tenantKey: row.tenantKey,
      eventType: 'invoice.charge_blocked_disputed',
      entityType: 'commission_invoice',
      entityId: row.id,
      payload: {
        attempted,
        paymentIntentId,
        disputeReason: row.disputeReason,
      },
    });
    return toRecord(row, await leadNameFor(db, row.leadId), billing.commissionRate, taxLabel);
  }

  /** #715: refund rows for one invoice, oldest first. */
  async function refundsFor(invoiceId: string): Promise<InvoiceRefundRecord[]> {
    const rows = await db.query.billingRefunds.findMany({
      where: eq(billingRefunds.invoiceId, invoiceId),
      orderBy: asc(billingRefunds.createdAt),
    });
    return rows.map(toRefundRecord);
  }

  /** #715: the single-invoice read — record plus its refunds. */
  async function detailRecord(
    row: typeof commissionInvoices.$inferSelect,
  ): Promise<CommissionInvoiceRecord> {
    return toRecord(
      row,
      await leadNameFor(db, row.leadId),
      billing.commissionRate,
      taxLabel,
      await refundsFor(row.id),
    );
  }

  /**
   * #715: admin_audit_log row for an admin money action. `detail` carries
   * ids and amounts only — never PII.
   */
  async function adminAuditLog(
    action: string,
    actorEmail: string | null,
    detail: string,
  ): Promise<void> {
    await deps.adminAudit?.log({ action, actorEmail, detail });
  }

  /**
   * #715: conditional status move for the admin correction actions, which
   * sit outside the charge-path ALLOWED_TRANSITIONS map on purpose (that
   * map guards webhooks and the timer). The UPDATE is conditional on the
   * expected status (plus any extra guard), so a concurrent transition
   * surfaces as 409 instead of being overwritten.
   */
  async function adminMove(
    id: string,
    from: CommissionInvoiceStatus,
    patch: Partial<typeof commissionInvoices.$inferInsert>,
    extraGuard?: ReturnType<typeof eq>,
  ): Promise<typeof commissionInvoices.$inferSelect> {
    const [updated] = await db
      .update(commissionInvoices)
      .set({ ...patch, updatedAt: now() })
      .where(
        and(
          eq(commissionInvoices.id, id),
          eq(commissionInvoices.status, from),
          extraGuard,
        ),
      )
      .returning();
    if (updated === undefined) {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        `Invoice "${id}" changed concurrently — expected '${from}'`,
      );
    }
    return updated;
  }

  /**
   * #715: finish a claimed card refund on the provider. Success →
   * 'succeeded' + the provider refund id. A definitive rejection → 'failed'
   * and the claimed amount is released on the invoice. Any other error
   * leaves the refund 'pending' (claim held) so a retry with the same key
   * resumes it with the same provider idempotency key. `completed` is true
   * only for the call whose conditional UPDATE moved the row pending →
   * succeeded, so exactly one caller writes the refund audit trail.
   */
  async function completeCardRefund(
    refund: typeof billingRefunds.$inferSelect,
    paymentIntentId: string,
  ): Promise<{ row: typeof billingRefunds.$inferSelect; completed: boolean }> {
    let providerRefund: { id: string; status: string };
    try {
      providerRefund = await stripe.refundPaymentIntent(
        paymentIntentId,
        `feasly:commission_invoices:${refund.invoiceId}:refund:${refund.idempotencyKey}`,
        refund.amountCents,
      );
    } catch (error) {
      if (isDefinitiveRefundRejection(error)) {
        const [failed] = await db
          .update(billingRefunds)
          .set({ status: 'failed', updatedAt: now() })
          .where(
            and(
              eq(billingRefunds.id, refund.id),
              eq(billingRefunds.status, 'pending'),
            ),
          )
          .returning();
        if (failed !== undefined) {
          await db
            .update(commissionInvoices)
            .set({
              refundedCents: sql`${commissionInvoices.refundedCents} - ${refund.amountCents}`,
              updatedAt: now(),
            })
            .where(eq(commissionInvoices.id, refund.invoiceId));
          await audit.append({
            tenantKey: refund.tenantKey,
            eventType: 'invoice.refund_failed',
            entityType: 'commission_invoice',
            entityId: refund.invoiceId,
            payload: {
              refundId: refund.id,
              amountCents: refund.amountCents,
              failureReason:
                error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      throw error;
    }
    const [succeeded] = await db
      .update(billingRefunds)
      .set({
        status: 'succeeded',
        stripeRefundId: providerRefund.id,
        updatedAt: now(),
      })
      .where(
        and(
          eq(billingRefunds.id, refund.id),
          eq(billingRefunds.status, 'pending'),
        ),
      )
      .returning();
    if (succeeded !== undefined) return { row: succeeded, completed: true };
    // A concurrent replay may have completed it first — re-read.
    return {
      row:
        (await db.query.billingRefunds.findFirst({
          where: eq(billingRefunds.id, refund.id),
        })) ?? refund,
      completed: false,
    };
  }

  /**
   * #715: the audit trail for a refund that just became final — the
   * `invoice.refunded` billing event plus the admin_audit_log row. Written
   * by whichever call finalised it: the original request, or the retry
   * that resumed a refund left pending by a transient provider error.
   */
  async function recordRefunded(
    refundRow: typeof billingRefunds.$inferSelect,
    adminEmail: string | null,
    resumed: boolean,
  ): Promise<CommissionInvoiceRecord> {
    const invoice = await detailRecord(await requireInvoice(refundRow.invoiceId));
    await audit.append({
      tenantKey: invoice.tenantKey,
      eventType: 'invoice.refunded',
      entityType: 'commission_invoice',
      entityId: invoice.id,
      payload: {
        refundId: refundRow.id,
        amountCents: refundRow.amountCents,
        method: refundRow.method,
        reason: refundRow.reason,
        ...(refundRow.note ? { note: refundRow.note } : {}),
        ...(refundRow.reference && refundRow.method === 'manual'
          ? { reference: refundRow.reference }
          : {}),
        ...(refundRow.stripeRefundId
          ? { stripeRefundId: refundRow.stripeRefundId }
          : {}),
        totalCents: invoice.totalCents,
        refundedCents: invoice.refundedCents,
        netCents: invoice.totalCents - invoice.refundedCents,
        refundState: invoice.refundState,
        adminEmail,
        ...(resumed ? { resumed: true } : {}),
      },
    });
    await adminAuditLog(
      'billing.invoice_refunded',
      adminEmail,
      `invoice=${invoice.id} refund=${refundRow.id} amount_cents=${refundRow.amountCents} method=${refundRow.method}` +
        (resumed ? ' resumed=true' : ''),
    );
    return invoice;
  }

  /** #715: replay a refund request whose idempotency key already exists. */
  async function replayRefund(
    invoiceId: string,
    existing: typeof billingRefunds.$inferSelect,
    adminEmail: string | null,
  ): Promise<RefundInvoiceResult> {
    if (existing.invoiceId !== invoiceId) {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        'This idempotency key was already used for a different invoice — generate a new key.',
      );
    }
    if (existing.status === 'failed') {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        'The refund attempt with this idempotency key failed — check the invoice and retry with a new key.',
      );
    }
    let refundRow = existing;
    if (existing.status === 'pending' && existing.method === 'stripe') {
      const invoiceRow = await requireInvoice(invoiceId);
      if (!invoiceRow.stripePaymentIntentId) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" has no PaymentIntent — the pending refund cannot be completed`,
        );
      }
      const result = await completeCardRefund(
        existing,
        invoiceRow.stripePaymentIntentId,
      );
      refundRow = result.row;
      // This retry finished the provider refund — it owns the audit trail.
      if (result.completed) {
        return {
          invoice: await recordRefunded(refundRow, adminEmail, true),
          refund: toRefundRecord(refundRow),
          replayed: true,
        };
      }
    }
    return {
      invoice: await detailRecord(await requireInvoice(invoiceId)),
      refund: toRefundRecord(refundRow),
      replayed: true,
    };
  }

  return {
    async createDraftInvoice(
      attributionId: string,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const record: AttributionRecord =
        await attribution.getById(attributionId);
      if (record.status !== 'attributed') {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Attribution "${attributionId}" has status '${record.status}' — only 'attributed' attributions can be invoiced`,
        );
      }
      if (
        record.contractValueCents === null ||
        record.contractSignedAt === null
      ) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Attribution "${attributionId}" has no reported contract to invoice`,
        );
      }
      const existing = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.attributionId, attributionId),
      });
      if (existing !== undefined) {
        // Idempotent: a retried won event (or a duplicate call) returns the
        // existing invoice instead of 409 — the embed-billing-hook already
        // treats this as "already billed". Audited so duplicates are visible.
        await audit.append({
          tenantKey: existing.tenantKey,
          eventType: 'invoice.create_duplicate_suppressed',
          entityType: 'commission_invoice',
          entityId: existing.id,
          payload: { attributionId },
        });
        return toRecord(existing, await leadNameFor(db, existing.leadId), billing.commissionRate, taxLabel);
      }

      const reportedAt = record.updatedAt;
      const onTime = isReportingOnTime(
        record.contractSignedAt,
        reportedAt,
        billing.reportingSlaDays,
      );
      // The builder's negotiated rate, snapshotted onto the invoice
      // (billing/08): future rate changes don't reprice this invoice.
      // Missing builder row (legacy tenant) → configured default.
      const builderRatePercent = await builderRatePercentFor(
        db,
        record.tenantKey,
      );
      const ratePercent = builderRatePercent ?? billing.commissionRate * 100;
      const taxRatePercent = taxConfig?.enabled ? taxConfig.ratePercent : 0;
      const taxInclusive = taxConfig?.enabled ? taxConfig.inclusive : false;
      const { commissionCents, taxCents, totalCents } = invoiceAmounts(
        computeCommissionCents(record.contractValueCents, ratePercent / 100),
        taxRatePercent,
        taxInclusive,
      );

      // billing/12: the invoice is created with the builder org's default
      // payment method (builders.settings.defaultPaymentMethod — 'card'
      // when unset) snapshotted onto the invoice, and a human-readable
      // invoice number (INV-0001…) from the sequence.
      const invoiceNumber = await nextInvoiceNumber(db);
      const paymentMethod = await builderDefaultPaymentMethodFor(
        db,
        record.tenantKey,
      );

      const [row] = await db
        .insert(commissionInvoices)
        .values({
          id: newId(),
          tenantKey: record.tenantKey,
          attributionId: record.id,
          leadId: record.leadId,
          contractValueCents: record.contractValueCents,
          commissionCents,
          commissionRatePercent: ratePercent,
          taxRatePercent,
          taxInclusive,
          taxCents,
          totalCents,
          slaBreached: !onTime,
          invoiceNumber,
          paymentMethod,
        })
        .returning()
        .catch(async (error: unknown) => {
          // Lost the won-event race: the UNIQUE backstop on attribution_id
          // (migration 0033) rejected our insert because a concurrent call
          // created the invoice first. Return the winner — never a 500,
          // never a second invoice/charge.
          if (!isUniqueViolation(error)) throw error;
          const winner = await db.query.commissionInvoices.findFirst({
            where: eq(commissionInvoices.attributionId, attributionId),
          });
          if (winner === undefined) throw error;
          await audit.append({
            tenantKey: winner.tenantKey,
            eventType: 'invoice.create_race_suppressed',
            entityType: 'commission_invoice',
            entityId: winner.id,
            payload: { attributionId },
          });
          return [winner];
        });
      const invoice = toRecord(row, await leadNameFor(db, row.leadId), billing.commissionRate, taxLabel);
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'invoice.created',
        entityType: 'commission_invoice',
        entityId: invoice.id,
        payload: {
          attributionId: record.id,
          contractValueCents: record.contractValueCents,
          commissionCents,
          commissionRatePercent: ratePercent,
          ...(taxRatePercent > 0
            ? { taxRatePercent, taxInclusive, taxCents, totalCents }
            : {}),
          invoiceNumber,
          paymentMethod,
          slaBreached: !onTime,
        },
      });

      if (!onTime) {
        const daysLate = wholeDaysBetween(
          record.contractSignedAt,
          reportedAt,
        ) - billing.reportingSlaDays;
        await audit.append({
          tenantKey: invoice.tenantKey,
          eventType: 'sla.breached',
          entityType: 'commission_invoice',
          entityId: invoice.id,
          payload: {
            sla: 'reporting',
            windowDays: billing.reportingSlaDays,
            daysLate,
          },
        });
        await alertOps(
          'Billing SLA breach: late contract report',
          `Tenant ${invoice.tenantKey} reported contract for attribution ` +
            `${record.id} ${daysLate} day(s) after the ${billing.reportingSlaDays}-day ` +
            `reporting SLA. Invoice ${invoice.id} flagged sla_breached.`,
        );
      }
      return invoice;
    },

    async submitForReview(
      invoiceId: string,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const row = await requireInvoice(invoiceId);
      if (row.status !== 'draft') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${row.status}' — only 'draft' can enter review`,
        );
      }
      const reviewDueAt = new Date(
        now().getTime() + reviewWindowDays * 86_400_000,
      );
      const invoice = await transition(
        invoiceId,
        'draft',
        'in_review',
        { reviewDueAt },
        'invoice.status_changed',
        { from: 'draft', reviewDueAt: reviewDueAt.toISOString() },
      );
      // BILL-04: the builder learns about the 7-day review window by
      // email the moment the invoice enters it.
      await notifyBuilder(invoice, 'invoice_ready');
      return invoice;
    },

    async finalizeInvoice(
      invoiceId: string,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const row = await requireInvoice(invoiceId);
      if (row.status !== 'in_review') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${row.status}' — only 'in_review' can be finalized`,
        );
      }
      // Defense-in-depth: the reviewer timer only feeds card invoices via
      // findDueReviews, but finalizeInvoice owns the no-manual-charge
      // invariant itself so no future caller can bypass it.
      requireCardPaymentMethod(invoiceId, row.paymentMethod);
      const customerId = await stripe.getCustomerId(row.tenantKey);
      if (!customerId) {
        throw new HttpError(
          422,
          ErrorCodes.BILLING_NOT_CONFIGURED,
          `Tenant "${row.tenantKey}" has no card on file — cannot charge`,
        );
      }
      const intent = await stripe.createOffSessionPaymentIntent(
        {
          amountCents: invoiceTotalCents(row),
          currency: row.currency,
          customerId,
          description:
            `Feasly commission ${formatRatePercent(effectiveRatePercent(row, billing.commissionRate))} — invoice ${invoiceId} ` +
            `(contract excl. land, attribution ${row.attributionId})`,
        },
        // Idempotency key: timer retries never double-charge.
        `feasly:commission_invoices:${invoiceId}:charge`,
      );
      return transition(
        invoiceId,
        'in_review',
        'finalized',
        { stripePaymentIntentId: intent.id, finalizedAt: now() },
        'invoice.charge_attempted',
        { paymentIntentId: intent.id, paymentIntentStatus: intent.status },
      );
    },

    async retryCharge(invoiceId: string): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const row = await requireInvoice(invoiceId);
      if (row.status === 'disputed') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is disputed — disputed invoices can never be retried`,
        );
      }
      if (row.status !== 'failed') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${row.status}' — only 'failed' can be retried`,
        );
      }
      // The retry must respect the invoice's current payment method: staff
      // may have switched a failed invoice to manual (e.g. cheque) — a card
      // retry here would double-collect.
      requireCardPaymentMethod(invoiceId, row.paymentMethod);
      const maxRetries = deps.billing.maxChargeRetries ?? 3;
      if (row.retryCount >= maxRetries) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Invoice "${invoiceId}" has used ${row.retryCount} of ${maxRetries} ` +
            'charge retries — manual handling required',
        );
      }
      const customerId = await stripe.getCustomerId(row.tenantKey);
      if (!customerId) {
        throw new HttpError(
          422,
          ErrorCodes.BILLING_NOT_CONFIGURED,
          `Tenant "${row.tenantKey}" has no card on file — cannot retry charge`,
        );
      }
      const retryNumber = row.retryCount + 1;
      const intent = await stripe.createOffSessionPaymentIntent(
        {
          amountCents: invoiceTotalCents(row),
          currency: row.currency,
          customerId,
          description:
            `Feasly commission ${formatRatePercent(effectiveRatePercent(row, billing.commissionRate))} — invoice ${invoiceId} ` +
            `(retry ${retryNumber}, contract excl. land, ` +
            `attribution ${row.attributionId})`,
        },
        // Idempotency key: distinct per retry attempt.
        `feasly:commission_invoices:${invoiceId}:retry:${retryNumber}`,
      );
      return transition(
        invoiceId,
        'failed',
        'finalized',
        {
          stripePaymentIntentId: intent.id,
          retryCount: retryNumber,
        },
        'invoice.charge_retried',
        {
          retryNumber,
          paymentIntentId: intent.id,
          paymentIntentStatus: intent.status,
        },
      );
    },

    async disputeInvoice(
      invoiceId: string,
      reason: string,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const row = await requireInvoice(invoiceId);
      if (row.status !== 'in_review') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${row.status}' — only 'in_review' can be disputed`,
        );
      }
      if (reason.trim().length === 0) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          'A dispute reason is required',
        );
      }
      const invoice = await transition(
        invoiceId,
        'in_review',
        'disputed',
        { disputeReason: reason.trim() },
        'invoice.disputed',
        { reason: reason.trim() },
      );
      // Dispute FREEZES the charge clock: the invoice-reviewer timer skips
      // 'disputed' rows until a human resolves them.
      await alertOps(
        'Billing dispute opened — charge frozen',
        `Tenant ${invoice.tenantKey} disputed invoice ${invoice.id} ` +
          `($${(invoice.totalCents / 100).toFixed(2)} ${invoice.currency}). ` +
          `Reason: ${reason.trim()}. The charge clock is frozen pending review.`,
      );
      return invoice;
    },

    async resolveDispute(
      invoiceId: string,
      outcome: 'resume' | 'void',
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const row = await requireInvoice(invoiceId);
      if (row.status !== 'disputed') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${row.status}' — only 'disputed' can be resolved`,
        );
      }
      if (outcome === 'void') {
        return transition(
          invoiceId,
          'disputed',
          'void',
          { disputeReason: row.disputeReason },
          'invoice.status_changed',
          { from: 'disputed', resolution: 'void' },
        );
      }
      // Resume: back to in_review with a FRESH 7-day window.
      const reviewDueAt = new Date(
        now().getTime() + reviewWindowDays * 86_400_000,
      );
      return transition(
        invoiceId,
        'disputed',
        'in_review',
        { reviewDueAt, disputeReason: null },
        'invoice.status_changed',
        {
          from: 'disputed',
          resolution: 'resume',
          reviewDueAt: reviewDueAt.toISOString(),
        },
      );
    },

    async markPaidByPaymentIntent(
      paymentIntentId: string,
      options?: SettlementOptions,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const row = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.stripePaymentIntentId, paymentIntentId),
      });
      if (row === undefined) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          `No invoice found for payment intent "${paymentIntentId}"`,
        );
      }
      const frozen = await frozenDispute(row, paymentIntentId, 'paid');
      if (frozen !== null) return frozen;
      if (TERMINAL_STATUSES.has(row.status as CommissionInvoiceStatus)) {
        // Webhook redelivery for an already-settled invoice: no-op, no
        // duplicate audit row.
        return toRecord(row, await leadNameFor(db, row.leadId), billing.commissionRate, taxLabel);
      }
      const invoice = await transition(
        row.id,
        row.status as CommissionInvoiceStatus,
        'paid',
        { paidAt: now() },
        'invoice.charge_succeeded',
        { paymentIntentId, source: options?.source ?? 'webhook' },
      );
      // BILL-04: receipt email on successful charge.
      await notifyBuilder(invoice, 'payment_received');
      return invoice;
    },

    async markPaidManually(
      invoiceId: string,
      input: ManualPaymentInput,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      if (!MANUAL_PAYMENT_METHODS.includes(input.paymentMethod)) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Unknown payment method "${String(input.paymentMethod)}" — ` +
            `expected one of: ${MANUAL_PAYMENT_METHODS.join(', ')}`,
        );
      }
      const row = await requireInvoice(invoiceId);
      const from = row.status as CommissionInvoiceStatus;
      if (from === 'paid') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is already paid — cannot mark paid again`,
        );
      }
      if (from === 'disputed') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is disputed — resolve the dispute before recording a payment`,
        );
      }
      if (from !== 'in_review' && from !== 'failed') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${from}' — only 'in_review' or 'failed' can be marked paid manually` +
            (from === 'finalized'
              ? ' (a finalized invoice has an in-flight Stripe PaymentIntent — mark the builder paid only after the charge fails, or refund the charge first)'
              : ''),
        );
      }
      const paidAt = input.paidAt ?? now();
      if (Number.isNaN(paidAt.getTime())) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'paidAt must be a valid ISO 8601 datetime',
        );
      }
      const reference =
        input.reference !== undefined && input.reference.trim().length > 0
          ? input.reference.trim()
          : null;
      // Moving to 'paid' cancels the scheduled auto-charge, and only for
      // statuses that have no live Stripe PaymentIntent: 'in_review' is
      // pre-charge (the invoice-reviewer timer only finalizes 'in_review'
      // rows via findDueReviews) and 'failed' means the charge already
      // failed. A 'finalized' invoice owns an in-flight PaymentIntent that
      // this path cannot cancel — mark-paid is rejected for it above — so
      // a late payment_intent.succeeded webhook can never double-charge:
      // it no-ops on the terminal status (markPaidByPaymentIntent). The
      // builder can never be charged twice for this invoice.
      const invoice = await transition(
        invoiceId,
        from,
        'paid',
        {
          manualPaymentMethod: input.paymentMethod,
          paymentReference: reference,
          paidAt,
          reviewDueAt: null,
        },
        'invoice.paid_manually',
        {
          from,
          paymentMethod: input.paymentMethod,
          reference,
          paidAt: paidAt.toISOString(),
          adminEmail: input.adminEmail,
        },
      );
      // Same receipt email as the Stripe path — the builder learns the
      // invoice is settled.
      await notifyBuilder(invoice, 'payment_received');
      return invoice;
    },

    async setCommissionRate(
      invoiceId: string,
      ratePercent: number,
      adminEmail: string | null,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      if (
        !Number.isFinite(ratePercent) ||
        ratePercent <= 0 ||
        ratePercent > 10
      ) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Commission rate must satisfy 0 < rate <= 10 (percent), got ${String(ratePercent)}`,
        );
      }
      const row = await requireInvoice(invoiceId);
      const status = row.status as CommissionInvoiceStatus;
      // Unpaid invoices only: settled (paid/void) and failed charges are
      // never repriced. Disputed IS allowed — it is unpaid, and a dispute
      // is often about the amount itself, so resolving it may mean fixing
      // the rate. Finalized keeps its own 409: the PaymentIntent amount is
      // already fixed.
      if (TERMINAL_STATUSES.has(status)) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${status}' — a settled or failed invoice is never repriced`,
        );
      }
      if (status === 'finalized') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" has a charge in flight — the rate cannot change after the PaymentIntent was created`,
        );
      }
      const oldRatePercent = effectiveRatePercent(
        row,
        billing.commissionRate,
      );
      const newRatePercent =
        Math.round(ratePercent * 10_000) / 10_000;
      // #714: tax is recalculated at the invoice's SNAPSHOTTED rate and
      // mode, never the current config.
      const {
        commissionCents: newCommissionCents,
        taxCents: newTaxCents,
        totalCents: newTotalCents,
      } = invoiceAmounts(
        computeCommissionCents(row.contractValueCents, newRatePercent / 100),
        row.taxRatePercent,
        row.taxInclusive,
      );
      // Conditional update on the current status — a concurrent transition
      // (e.g. finalize racing this override) surfaces as 409 instead of
      // silently repricing an invoice that just moved.
      const [updated] = await db
        .update(commissionInvoices)
        .set({
          commissionRateOverride: newRatePercent,
          commissionCents: newCommissionCents,
          taxCents: newTaxCents,
          totalCents: newTotalCents,
          updatedAt: now(),
        })
        .where(
          and(
            eq(commissionInvoices.id, invoiceId),
            eq(commissionInvoices.status, status),
          ),
        )
        .returning();
      if (updated === undefined) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" changed concurrently — expected '${status}'`,
        );
      }
      const record = toRecord(updated, await leadNameFor(db, updated.leadId), billing.commissionRate, taxLabel);
      await audit.append({
        tenantKey: record.tenantKey,
        eventType: 'invoice.commission_rate_changed',
        entityType: 'commission_invoice',
        entityId: record.id,
        payload: {
          fromRatePercent: oldRatePercent,
          toRatePercent: newRatePercent,
          oldCommissionCents: row.commissionCents,
          newCommissionCents,
          ...(row.taxRatePercent > 0
            ? {
                taxRatePercent: row.taxRatePercent,
                oldTaxCents: row.taxCents,
                newTaxCents,
                oldTotalCents: invoiceTotalCents(row),
                newTotalCents,
              }
            : {}),
          contractValueCents: row.contractValueCents,
          adminEmail,
        },
      });
      return record;
    },

    async markFailedByPaymentIntent(
      paymentIntentId: string,
      failureReason?: string,
      options?: SettlementOptions,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const row = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.stripePaymentIntentId, paymentIntentId),
      });
      if (row === undefined) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          `No invoice found for payment intent "${paymentIntentId}"`,
        );
      }
      const frozenFailed = await frozenDispute(row, paymentIntentId, 'failed');
      if (frozenFailed !== null) return frozenFailed;
      if (TERMINAL_STATUSES.has(row.status as CommissionInvoiceStatus)) {
        return toRecord(row, await leadNameFor(db, row.leadId), billing.commissionRate, taxLabel);
      }
      const invoice = await transition(
        row.id,
        row.status as CommissionInvoiceStatus,
        'failed',
        {},
        'invoice.charge_failed',
        // BILL-03: the dunning queue shows the last failure reason.
        {
          paymentIntentId,
          source: options?.source ?? 'webhook',
          ...(failureReason !== undefined && failureReason.length > 0
            ? { failureReason }
            : {}),
        },
      );
      // BILL-04: "card declined — update it" email on failed charge.
      await notifyBuilder(invoice, 'payment_failed');
      await alertOps(
        'Billing charge failed — dunning started',
        `Off-session charge for invoice ${invoice.id} ` +
          `($${(invoice.totalCents / 100).toFixed(2)} ${invoice.currency}, ` +
          `tenant ${invoice.tenantKey}) failed. Payment intent ${paymentIntentId}. ` +
          `Update the card on file and re-attempt.`,
      );
      return invoice;
    },

    async findDueReviews(reviewNow: Date): Promise<CommissionInvoiceRecord[]> {
      requireCommissionModel();
      const rows = await db.query.commissionInvoices.findMany({
        where: and(
          eq(commissionInvoices.status, 'in_review'),
          lte(commissionInvoices.reviewDueAt, reviewNow),
          // billing/12: manual-method invoices are NEVER auto-charged —
          // they sit until staff marks them paid via the admin mark-paid
          // flow. Only 'card' invoices reach finalizeInvoice.
          eq(commissionInvoices.paymentMethod, 'card'),
        ),
      });
      const names = await leadNamesById(
        db,
        rows.map((row) => row.leadId),
      );
      return rows.map((row) => toRecord(row, names.get(row.leadId) ?? '', billing.commissionRate, taxLabel));
    },

    async findAwaitingSettlement(
      cutoff: Date,
    ): Promise<CommissionInvoiceRecord[]> {
      requireCommissionModel();
      // updatedAt is stamped by transition() when the invoice entered
      // 'finalized' (first charge or retry) — the charge-in-progress clock.
      const rows = await db.query.commissionInvoices.findMany({
        where: and(
          eq(commissionInvoices.status, 'finalized'),
          lte(commissionInvoices.updatedAt, cutoff),
          isNotNull(commissionInvoices.stripePaymentIntentId),
        ),
      });
      const names = await leadNamesById(
        db,
        rows.map((row) => row.leadId),
      );
      return rows.map((row) => toRecord(row, names.get(row.leadId) ?? '', billing.commissionRate, taxLabel));
    },

    async countSkippedManualReviews(reviewNow: Date): Promise<number> {
      requireCommissionModel();
      const rows = await db.query.commissionInvoices.findMany({
        columns: { id: true },
        where: and(
          eq(commissionInvoices.status, 'in_review'),
          lte(commissionInvoices.reviewDueAt, reviewNow),
          ne(commissionInvoices.paymentMethod, 'card'),
        ),
      });
      return rows.length;
    },

    async findByAttribution(
      attributionId: string,
    ): Promise<CommissionInvoiceRecord | null> {
      requireCommissionModel();
      const row = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.attributionId, attributionId),
      });
      if (row === undefined) {
        return null;
      }
      return toRecord(row, await leadNameFor(db, row.leadId), billing.commissionRate, taxLabel);
    },

    async findByLead(leadId: string): Promise<CommissionInvoiceRecord | null> {
      requireCommissionModel();
      const row = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.leadId, leadId),
      });
      if (row === undefined) {
        return null;
      }
      return toRecord(row, await leadNameFor(db, row.leadId), billing.commissionRate, taxLabel);
    },

    async getById(invoiceId: string): Promise<CommissionInvoiceRecord> {
      return detailRecord(await requireInvoice(invoiceId));
    },

    async getCommissionRatePercent(tenantKey: string): Promise<number> {
      requireCommissionModel();
      return (
        (await builderRatePercentFor(db, tenantKey)) ??
        billing.commissionRate * 100
      );
    },

    async getDefaultPaymentMethod(
      tenantKey: string,
    ): Promise<BuilderPaymentMethod> {
      requireCommissionModel();
      return builderDefaultPaymentMethodFor(db, tenantKey);
    },

    async setDefaultPaymentMethod(
      tenantKey: string,
      method: BuilderPaymentMethod,
    ): Promise<BuilderPaymentMethod> {
      requireCommissionModel();
      const validated = requireKnownPaymentMethod(method);
      const row = await db.query.builders.findFirst({
        where: eq(builders.tenantKey, tenantKey),
      });
      if (row === undefined) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          `Builder not found: "${tenantKey}"`,
        );
      }
      const settings = {
        ...(row.settings ?? {}),
        defaultPaymentMethod: validated,
      };
      await db
        .update(builders)
        .set({ settings, updatedAt: now() })
        .where(eq(builders.tenantKey, tenantKey));
      await audit.append({
        tenantKey,
        eventType: 'builder.default_payment_method_changed',
        entityType: 'builder',
        entityId: row.id,
        payload: {
          from: readDefaultPaymentMethod(row.settings),
          to: validated,
        },
      });
      return validated;
    },

    async setInvoicePaymentMethod(
      tenantKey: string,
      invoiceId: string,
      method: BuilderPaymentMethod,
    ): Promise<CommissionInvoiceRecord> {
      requireCommissionModel();
      const validated = requireKnownPaymentMethod(method);
      const row = await requireInvoice(invoiceId);
      if (row.tenantKey !== tenantKey) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This invoice belongs to a different builder.',
        );
      }
      const status = row.status as CommissionInvoiceStatus;
      // Every unpaid invoice is changeable (Karan): draft, in_review,
      // failed, and finalized. A finalized invoice owns an in-flight Stripe
      // PaymentIntent that this path does not cancel — the intent resolves
      // via webhook (paid/failed) regardless; the new method governs what
      // happens next (a failed charge is retried/handled manually, never
      // auto-charged when the method is manual). Paid, void, and disputed
      // invoices stay locked: settled, no balance, and dispute-frozen.
      if (
        status !== 'draft' &&
        status !== 'in_review' &&
        status !== 'failed' &&
        status !== 'finalized'
      ) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${status}' — the payment method can only change while the invoice is unpaid (draft, in_review, failed, finalized)`,
        );
      }
      const from = row.paymentMethod as BuilderPaymentMethod;
      if (from === validated) {
        // Idempotent: same method is a no-op (still returns the record).
        return toRecord(row, await leadNameFor(db, row.leadId), billing.commissionRate, taxLabel);
      }
      // Conditional update on the current status — a concurrent
      // transition (e.g. the timer finalizing this invoice) surfaces as
      // 409 instead of silently re-routing a charge.
      const [updated] = await db
        .update(commissionInvoices)
        .set({ paymentMethod: validated, updatedAt: now() })
        .where(
          and(
            eq(commissionInvoices.id, invoiceId),
            eq(commissionInvoices.status, status),
          ),
        )
        .returning();
      if (updated === undefined) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" changed concurrently — expected '${status}'`,
        );
      }
      const record = toRecord(updated, await leadNameFor(db, updated.leadId), billing.commissionRate, taxLabel);
      await audit.append({
        tenantKey: record.tenantKey,
        eventType: 'invoice.payment_method_changed',
        entityType: 'commission_invoice',
        entityId: record.id,
        payload: {
          from,
          to: validated,
          // Switching to manual pauses the Stripe auto-charge; back to
          // card re-arms it. The audit row makes the pause visible.
          autoChargePaused: validated !== 'card',
        },
      });
      return record;
    },

    async listInvoices(
      tenantKey: string | null,
      opts: {
        limit: number;
        offset: number;
        invoiceNumber?: string;
        status?: string[];
      },
    ): Promise<CommissionInvoiceRecord[]> {
      requireCommissionModel();
      const limit = Math.min(Math.max(opts.limit, 1), 100);
      const offset = Math.max(opts.offset, 0);
      // Case-insensitive partial match on the invoice number. LIKE
      // wildcards in the user's input are escaped so "%" can't widen the
      // match beyond a literal substring search.
      const invoiceNumber = opts.invoiceNumber?.trim();
      // Optional status filter (dashboard due-invoice banners). The route
      // validates values against the known statuses; an empty array here
      // means no filter.
      const statuses = opts.status?.filter((s) => s.length > 0);
      const rows = await db.query.commissionInvoices.findMany({
        where: and(
          tenantKey === null
            ? undefined
            : eq(commissionInvoices.tenantKey, tenantKey),
          invoiceNumber
            ? ilike(
                commissionInvoices.invoiceNumber,
                `%${escapeLikePattern(invoiceNumber)}%`,
              )
            : undefined,
          statuses && statuses.length > 0
            ? inArray(commissionInvoices.status, statuses)
            : undefined,
        ),
        orderBy: desc(commissionInvoices.createdAt),
        limit,
        offset,
      });
      const names = await leadNamesById(
        db,
        rows.map((row) => row.leadId),
      );
      return rows.map((row) => toRecord(row, names.get(row.leadId) ?? '', billing.commissionRate, taxLabel));
    },

    async refundInvoice(
      invoiceId: string,
      input: RefundInvoiceInput,
    ): Promise<RefundInvoiceResult> {
      requireCommissionModel();
      if (!INVOICE_REFUND_REASONS.includes(input.reason)) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Unknown refund reason "${String(input.reason)}" — expected one of: ${INVOICE_REFUND_REASONS.join(', ')}`,
        );
      }
      const idempotencyKey = input.idempotencyKey.trim();
      if (idempotencyKey.length === 0) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'An idempotency key is required for refunds',
        );
      }
      // Replay first: a retried request must return the original result
      // even after the invoice has moved on (e.g. fully refunded).
      const prior = await db.query.billingRefunds.findFirst({
        where: eq(billingRefunds.idempotencyKey, idempotencyKey),
      });
      if (prior !== undefined) return replayRefund(invoiceId, prior, input.adminEmail);

      const row = await requireInvoice(invoiceId);
      if (row.status !== 'paid') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${row.status}' — only a paid invoice can be refunded` +
            (row.status === 'draft' || row.status === 'in_review' || row.status === 'failed'
              ? ' (void it instead)'
              : ''),
        );
      }
      const totalCents = invoiceTotalCents(row);
      const remainingCents = totalCents - row.refundedCents;
      if (remainingCents <= 0) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Invoice "${invoiceId}" is already fully refunded — nothing left to refund`,
        );
      }
      const amountCents = input.amountCents ?? remainingCents;
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Refund amount must be a positive whole number of cents',
        );
      }
      if (amountCents > remainingCents) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Refund of ${amountCents} cents exceeds the ${remainingCents} cents ` +
            `left to refund on invoice "${invoiceId}" (total ${totalCents}, ` +
            `already refunded ${row.refundedCents})`,
        );
      }
      // Card-paid → provider refund on the PaymentIntent. Marked paid by
      // hand → the money went back off-Stripe; a reference is required.
      const method: InvoiceRefundMethod =
        row.manualPaymentMethod === null && row.stripePaymentIntentId !== null
          ? 'stripe'
          : 'manual';
      const reference = optionalText(input.reference);
      if (method === 'manual' && reference === null) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          `Invoice "${invoiceId}" was paid off-Stripe — record the refund's cheque/trace reference`,
        );
      }

      // 1+2. One transaction: claim the idempotency key (UNIQUE) and
      //      reserve the amount on the invoice. A crash can never leave a
      //      refund row without its reservation (or the reverse). A
      //      concurrent duplicate loses the insert and replays the winner —
      //      one refund, ever. The reservation guard means concurrent
      //      refunds with different keys can never exceed the amount paid.
      //      The provider call stays outside the transaction.
      const refundId = newId();
      let refundRow: typeof billingRefunds.$inferSelect;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        refundRow = await db.transaction(async (tx: any) => {
          const [inserted] = await tx
            .insert(billingRefunds)
            .values({
              id: refundId,
              invoiceId,
              tenantKey: row.tenantKey,
              amountCents,
              currency: row.currency,
              reason: input.reason,
              note: optionalText(input.note),
              method,
              status: method === 'manual' ? 'succeeded' : 'pending',
              reference: method === 'manual' ? reference : null,
              idempotencyKey,
              actorEmail: input.adminEmail,
              createdAt: now(),
              updatedAt: now(),
            })
            .returning();
          const [reserved] = await tx
            .update(commissionInvoices)
            .set({
              refundedCents: sql`${commissionInvoices.refundedCents} + ${amountCents}`,
              updatedAt: now(),
            })
            .where(
              and(
                eq(commissionInvoices.id, invoiceId),
                eq(commissionInvoices.status, 'paid'),
                sql`${commissionInvoices.refundedCents} + ${amountCents} <= coalesce(${commissionInvoices.totalCents}, ${commissionInvoices.commissionCents} + ${commissionInvoices.taxCents})`,
              ),
            )
            .returning();
          if (reserved === undefined) {
            // Rolls back the claim too — nothing is recorded.
            throw new HttpError(
              422,
              ErrorCodes.VALIDATION_FAILED,
              `Invoice "${invoiceId}" changed while refunding — the amount now exceeds what is left to refund. Reload and retry.`,
            );
          }
          return inserted as typeof billingRefunds.$inferSelect;
        });
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error;
        const winner = await db.query.billingRefunds.findFirst({
          where: eq(billingRefunds.idempotencyKey, idempotencyKey),
        });
        if (winner === undefined) {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            'Refund request collided with a concurrent one — retry',
          );
        }
        return replayRefund(invoiceId, winner, input.adminEmail);
      }

      // 3. Card refund on the provider (manual refunds are already final).
      //    If a concurrent replay finalised it first, that call wrote the
      //    audit trail.
      if (method === 'stripe') {
        const result = await completeCardRefund(
          refundRow,
          row.stripePaymentIntentId as string,
        );
        refundRow = result.row;
        if (!result.completed) {
          return {
            invoice: await detailRecord(await requireInvoice(invoiceId)),
            refund: toRefundRecord(refundRow),
            replayed: false,
          };
        }
      }

      const invoice = await recordRefunded(refundRow, input.adminEmail, false);
      return { invoice, refund: toRefundRecord(refundRow), replayed: false };
    },

    async voidInvoice(
      invoiceId: string,
      input: VoidInvoiceInput,
    ): Promise<{ invoice: CommissionInvoiceRecord; previousStatus: CommissionInvoiceStatus }> {
      requireCommissionModel();
      if (!VOID_INVOICE_REASONS.includes(input.reason)) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Unknown void reason "${String(input.reason)}" — expected one of: ${VOID_INVOICE_REASONS.join(', ')}`,
        );
      }
      const row = await requireInvoice(invoiceId);
      const from = row.status as CommissionInvoiceStatus;
      if (from !== 'draft' && from !== 'in_review' && from !== 'failed') {
        const why: Record<string, string> = {
          finalized: 'a charge is in flight — wait for it to settle, then refund or void',
          paid: 'it is paid — refund it instead',
          disputed: 'it is disputed — resolve it in the dispute console',
          void: 'it is already void',
        };
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" cannot be voided: ${why[from] ?? `status '${from}'`}`,
        );
      }
      const note = optionalText(input.note);
      const updated = await adminMove(invoiceId, from, {
        status: 'void',
        // No charge clock remains on a void invoice.
        reviewDueAt: null,
      });
      const invoice = await detailRecord(updated);
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'invoice.voided',
        entityType: 'commission_invoice',
        entityId: invoice.id,
        payload: {
          status: 'void',
          from,
          reason: input.reason,
          ...(note ? { note } : {}),
          totalCents: invoice.totalCents,
          adminEmail: input.adminEmail,
        },
      });
      await adminAuditLog(
        'billing.invoice_voided',
        input.adminEmail,
        `invoice=${invoice.id} from=${from} reason=${input.reason}`,
      );
      return { invoice, previousStatus: from };
    },

    async correctContract(
      invoiceId: string,
      input: CorrectContractInput,
    ): Promise<CorrectContractResult> {
      requireCommissionModel();
      if (
        !Number.isSafeInteger(input.contractValueCents) ||
        input.contractValueCents <= 0
      ) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'contractValueCents must be a positive whole number of cents',
        );
      }
      if (Number.isNaN(input.contractSignedAt.getTime())) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'contractSignedAt must be a valid ISO 8601 datetime',
        );
      }
      const note = input.note.trim();
      if (note.length === 0) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          'A note explaining the correction is required',
        );
      }
      const row = await requireInvoice(invoiceId);
      const status = row.status as CommissionInvoiceStatus;
      if (status !== 'draft' && status !== 'in_review') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${status}' — the contract can only be corrected before the invoice is charged (draft, in_review)`,
        );
      }
      const attributionRow = await db.query.attributionEvents.findFirst({
        where: eq(attributionEvents.id, row.attributionId),
      });
      const ratePercent = effectiveRatePercent(row, billing.commissionRate);
      // #714: tax at the invoice's SNAPSHOTTED rate and mode.
      const amounts = invoiceAmounts(
        computeCommissionCents(input.contractValueCents, ratePercent / 100),
        row.taxRatePercent,
        row.taxInclusive,
      );
      const reviewDueAt =
        status === 'in_review'
          ? new Date(now().getTime() + reviewWindowDays * 86_400_000)
          : row.reviewDueAt;
      const updated = await adminMove(invoiceId, status, {
        contractValueCents: input.contractValueCents,
        commissionCents: amounts.commissionCents,
        taxCents: amounts.taxCents,
        totalCents: amounts.totalCents,
        reviewDueAt,
      });
      // Keep the attribution's reported contract in step with the invoice
      // (it is what reportContract compares a re-report against).
      await db
        .update(attributionEvents)
        .set({
          contractValueCents: input.contractValueCents,
          contractSignedAt: input.contractSignedAt,
          updatedAt: now(),
        })
        .where(eq(attributionEvents.id, row.attributionId));
      const invoice = await detailRecord(updated);
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'invoice.contract_corrected',
        entityType: 'commission_invoice',
        entityId: invoice.id,
        payload: {
          status,
          note,
          ratePercent,
          old: {
            contractValueCents: row.contractValueCents,
            contractSignedAt:
              attributionRow?.contractSignedAt?.toISOString() ?? null,
            commissionCents: row.commissionCents,
            taxCents: row.taxCents,
            totalCents: invoiceTotalCents(row),
            reviewDueAt: row.reviewDueAt?.toISOString() ?? null,
          },
          new: {
            contractValueCents: input.contractValueCents,
            contractSignedAt: input.contractSignedAt.toISOString(),
            commissionCents: amounts.commissionCents,
            taxCents: amounts.taxCents,
            totalCents: amounts.totalCents,
            reviewDueAt: reviewDueAt?.toISOString() ?? null,
          },
          adminEmail: input.adminEmail,
        },
      });
      await adminAuditLog(
        'billing.invoice_contract_corrected',
        input.adminEmail,
        `invoice=${invoice.id} contract_cents=${row.contractValueCents}->${input.contractValueCents} total_cents=${invoiceTotalCents(row)}->${amounts.totalCents}`,
      );
      // The builder hears about the corrected amount and the restarted
      // review window (a draft has not been issued yet — no email).
      if (status === 'in_review') {
        await notifyBuilder(invoice, 'invoice_ready');
      }
      return {
        invoice,
        previousContractValueCents: row.contractValueCents,
        contractSignedAt: input.contractSignedAt,
      };
    },

    async reverseManualPayment(
      invoiceId: string,
      input: ReverseManualPaymentInput,
    ): Promise<ReverseManualPaymentResult> {
      requireCommissionModel();
      const reason = input.reason.trim();
      if (reason.length === 0) {
        throw new HttpError(
          422,
          ErrorCodes.VALIDATION_FAILED,
          'A reason is required to reverse a payment',
        );
      }
      const row = await requireInvoice(invoiceId);
      if (row.status !== 'paid') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" is '${row.status}' — only a paid invoice can have its payment reversed`,
        );
      }
      if (row.manualPaymentMethod === null) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" was paid by card — refund it instead of reversing the payment`,
        );
      }
      if (row.refundedCents > 0) {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoiceId}" has refunds recorded — a refunded payment cannot be reversed`,
        );
      }
      const reversedPaymentMethod = row.manualPaymentMethod as ManualPaymentMethod;
      const reversedReference = row.paymentReference;
      const updated = await adminMove(
        invoiceId,
        'paid',
        {
          status: 'failed',
          paidAt: null,
          manualPaymentMethod: null,
          paymentReference: null,
        },
        // Guard against a refund landing between the read and the update.
        eq(commissionInvoices.refundedCents, 0),
      );
      const invoice = await detailRecord(updated);
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'invoice.payment_reversed',
        entityType: 'commission_invoice',
        entityId: invoice.id,
        payload: {
          status: 'failed',
          from: 'paid',
          reason,
          reversedPaymentMethod,
          reversedReference,
          reversedPaidAt: row.paidAt?.toISOString() ?? null,
          totalCents: invoice.totalCents,
          adminEmail: input.adminEmail,
        },
      });
      await adminAuditLog(
        'billing.invoice_payment_reversed',
        input.adminEmail,
        `invoice=${invoice.id} method=${reversedPaymentMethod}`,
      );
      return { invoice, reversedPaymentMethod, reversedReference };
    },
  };
}
