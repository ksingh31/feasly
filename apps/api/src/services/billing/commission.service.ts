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
import { and, eq, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import { commissionInvoices } from '../../db/schema';
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CommissionService {
  /**
   * Won deal → draft invoice. Reads the reported contract from the
   * attribution service; exactly one invoice per attribution (unique).
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
  /** Builder disputes — charge clock FROZEN, ops alerted. */
  disputeInvoice(invoiceId: string, reason: string): Promise<CommissionInvoiceRecord>;
  /** Human resolution of a dispute: back to review or void. */
  resolveDispute(
    invoiceId: string,
    outcome: 'resume' | 'void',
  ): Promise<CommissionInvoiceRecord>;
  /** Webhook: payment_intent.succeeded. */
  markPaidByPaymentIntent(paymentIntentId: string): Promise<CommissionInvoiceRecord>;
  /** Webhook: payment_intent.payment_failed → dunning. */
  markFailedByPaymentIntent(paymentIntentId: string): Promise<CommissionInvoiceRecord>;
  /** In-review invoices whose review window has passed (timer input). */
  findDueReviews(now: Date): Promise<CommissionInvoiceRecord[]>;
  getById(invoiceId: string): Promise<CommissionInvoiceRecord>;
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

  async function transition(
    id: string,
    status: CommissionInvoiceStatus,
    patch: Partial<typeof commissionInvoices.$inferInsert>,
    eventType: string,
    eventPayload?: Record<string, unknown>,
  ): Promise<CommissionInvoiceRecord> {
    const [updated] = await db
      .update(commissionInvoices)
      .set({ ...patch, status, updatedAt: now() })
      .where(eq(commissionInvoices.id, id))
      .returning();
    const record = toRecord(updated);
    await audit.append({
      tenantKey: record.tenantKey,
      eventType,
      entityType: 'commission_invoice',
      entityId: record.id,
      payload: {
        status,
        commissionCents: record.commissionCents,
        ...eventPayload,
      },
    });
    return record;
  }

  async function alertOps(title: string, summary: string): Promise<void> {
    await email.sendOpsAlert({
      to: deps.opsInbox,
      title,
      summary,
      firedAt: now(),
    });
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
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Attribution "${attributionId}" already has invoice "${existing.id}"`,
        );
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
        .returning();
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
      return transition(
        invoiceId,
        'in_review',
        { reviewDueAt },
        'invoice.status_changed',
        { from: 'draft', reviewDueAt: reviewDueAt.toISOString() },
      );
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
        'finalized',
        { stripePaymentIntentId: intent.id, finalizedAt: now() },
        'invoice.charge_attempted',
        { paymentIntentId: intent.id, paymentIntentStatus: intent.status },
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
      if (TERMINAL_STATUSES.has(row.status as CommissionInvoiceStatus)) {
        // Webhook redelivery for an already-settled invoice: no-op, no
        // duplicate audit row.
        return toRecord(row);
      }
      return transition(
        row.id,
        'paid',
        { paidAt: now() },
        'invoice.charge_succeeded',
        { paymentIntentId },
      );
    },

    async markFailedByPaymentIntent(
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
      if (TERMINAL_STATUSES.has(row.status as CommissionInvoiceStatus)) {
        return toRecord(row);
      }
      const invoice = await transition(
        row.id,
        'failed',
        {},
        'invoice.charge_failed',
        { paymentIntentId },
      );
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

    async getById(invoiceId: string): Promise<CommissionInvoiceRecord> {
      return toRecord(await requireInvoice(invoiceId));
    },
  };
}
