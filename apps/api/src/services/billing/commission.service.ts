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
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, desc, eq, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import { builderAllowlist, builders, commissionInvoices, tenants } from '../../db/schema';
import { HttpError, ErrorCodes } from '../../middleware/errors';
import {
  computeCommissionCents,
  wholeDaysBetween,
} from '../../lib/commission-math';
import { isReportingOnTime } from '../../lib/billing-deadlines';
import type {
  AttributionService,
  AttributionRecord,
} from './attribution.service';
import type { BillingAuditService } from './billing-audit.service';
import type { StripeService } from './stripe.service';
import type { EmailService } from '../email/email.service';
import { EmailProviderError } from '../email';

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
  readonly contractValueCents: number;
  readonly commissionCents: number;
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
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
  markPaidByPaymentIntent(paymentIntentId: string): Promise<CommissionInvoiceRecord>;
  /**
   * Webhook: payment_intent.payment_failed → dunning. No-op (audited) while
   * the invoice is 'disputed'. The optional failure reason is recorded in
   * the audit payload so the dunning queue can show it (BILL-03).
   */
  markFailedByPaymentIntent(
    paymentIntentId: string,
    failureReason?: string,
  ): Promise<CommissionInvoiceRecord>;
  /** In-review invoices whose review window has passed (timer input). */
  findDueReviews(now: Date): Promise<CommissionInvoiceRecord[]>;
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
   * BILL-04: paginated invoice list, newest first. Builders pass their
   * tenantKey (scoped); admins pass null (all tenants).
   */
  listInvoices(
    tenantKey: string | null,
    opts: { limit: number; offset: number },
  ): Promise<CommissionInvoiceRecord[]>;
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
  in_review: new Set(['finalized', 'disputed']),
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
  failed: new Set(['finalized']),
  disputed: new Set(['in_review', 'void']),
  void: new Set([]),
};

import { isUniqueViolation } from './pg-errors';

function toRecord(
  row: typeof commissionInvoices.$inferSelect,
): CommissionInvoiceRecord {
  return {
    id: row.id,
    tenantKey: row.tenantKey,
    attributionId: row.attributionId,
    leadId: row.leadId,
    contractValueCents: row.contractValueCents,
    commissionCents: row.commissionCents,
    currency: row.currency,
    stripePaymentIntentId: row.stripePaymentIntentId,
    status: row.status as CommissionInvoiceStatus,
    reviewDueAt: row.reviewDueAt,
    finalizedAt: row.finalizedAt,
    paidAt: row.paidAt,
    slaBreached: row.slaBreached,
    disputeReason: row.disputeReason,
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createCommissionService(
  deps: CommissionServiceDeps,
): CommissionService {
  const { db, billing, attribution, audit, stripe, email } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const reviewWindowDays = deps.reviewWindowDays ?? 7;

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
    const record = toRecord(updated);
    await audit.append({
      tenantKey: record.tenantKey,
      eventType,
      entityType: 'commission_invoice',
      entityId: record.id,
      payload: {
        status: to,
        commissionCents: record.commissionCents,
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
    if (!delivery.sent) {
      throw new EmailProviderError(`Ops alert email failed: ${delivery.failureReason}`, {
        retryable: false,
        failureCode: delivery.emailError,
      });
    }
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
        reviewDueAt: invoice.reviewDueAt,
      });
    } else if (kind === 'payment_received') {
      if (!invoice.paidAt) return;
      delivery = await email.sendCommissionPaymentReceived({
        to,
        invoiceRef,
        commissionCents: invoice.commissionCents,
        currency: invoice.currency,
        paidAt: invoice.paidAt,
      });
    } else {
      delivery = await email.sendCommissionPaymentFailed({
        to,
        invoiceRef,
        commissionCents: invoice.commissionCents,
        currency: invoice.currency,
        updateWithinDays: 7,
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
    return toRecord(row);
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
        return toRecord(existing);
      }

      const reportedAt = record.updatedAt;
      const onTime = isReportingOnTime(
        record.contractSignedAt,
        reportedAt,
        billing.reportingSlaDays,
      );
      const commissionCents = computeCommissionCents(
        record.contractValueCents,
        billing.commissionRate,
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
          slaBreached: !onTime,
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
      const invoice = toRecord(row);
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'invoice.created',
        entityType: 'commission_invoice',
        entityId: invoice.id,
        payload: {
          attributionId: record.id,
          contractValueCents: record.contractValueCents,
          commissionCents,
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
          amountCents: row.commissionCents,
          currency: row.currency,
          customerId,
          description:
            `Feasly commission 1% — invoice ${invoiceId} ` +
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
          amountCents: row.commissionCents,
          currency: row.currency,
          customerId,
          description:
            `Feasly commission 1% — invoice ${invoiceId} ` +
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
          `($${(invoice.commissionCents / 100).toFixed(2)} ${invoice.currency}). ` +
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
        return toRecord(row);
      }
      const invoice = await transition(
        row.id,
        row.status as CommissionInvoiceStatus,
        'paid',
        { paidAt: now() },
        'invoice.charge_succeeded',
        { paymentIntentId },
      );
      // BILL-04: receipt email on successful charge.
      await notifyBuilder(invoice, 'payment_received');
      return invoice;
    },

    async markFailedByPaymentIntent(
      paymentIntentId: string,
      failureReason?: string,
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
        return toRecord(row);
      }
      const invoice = await transition(
        row.id,
        row.status as CommissionInvoiceStatus,
        'failed',
        {},
        'invoice.charge_failed',
        // BILL-03: the dunning queue shows the last failure reason.
        failureReason !== undefined && failureReason.length > 0
          ? { paymentIntentId, failureReason }
          : { paymentIntentId },
      );
      // BILL-04: "card declined — update it" email on failed charge.
      await notifyBuilder(invoice, 'payment_failed');
      await alertOps(
        'Billing charge failed — dunning started',
        `Off-session charge for invoice ${invoice.id} ` +
          `($${(invoice.commissionCents / 100).toFixed(2)} ${invoice.currency}, ` +
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
        ),
      });
      return rows.map(toRecord);
    },

    async findByAttribution(
      attributionId: string,
    ): Promise<CommissionInvoiceRecord | null> {
      requireCommissionModel();
      const row = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.attributionId, attributionId),
      });
      return row === undefined ? null : toRecord(row);
    },

    async findByLead(leadId: string): Promise<CommissionInvoiceRecord | null> {
      requireCommissionModel();
      const row = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.leadId, leadId),
      });
      return row === undefined ? null : toRecord(row);
    },

    async getById(invoiceId: string): Promise<CommissionInvoiceRecord> {
      return toRecord(await requireInvoice(invoiceId));
    },

    async listInvoices(
      tenantKey: string | null,
      opts: { limit: number; offset: number },
    ): Promise<CommissionInvoiceRecord[]> {
      requireCommissionModel();
      const limit = Math.min(Math.max(opts.limit, 1), 100);
      const offset = Math.max(opts.offset, 0);
      const rows = await db.query.commissionInvoices.findMany({
        where:
          tenantKey === null
            ? undefined
            : eq(commissionInvoices.tenantKey, tenantKey),
        orderBy: desc(commissionInvoices.createdAt),
        limit,
        offset,
      });
      return rows.map(toRecord);
    },
  };
}
