/**
 * Dispute console backend (billing/01 follow-on, was OPS-009).
 *
 * Owns the `billing_disputes` table: one row per builder dispute, opened
 * when an invoice transitions to 'disputed' (hooked from the billing
 * facade's disputeInvoice — see billing.service.ts). The evidence snapshot
 * is IMMUTABLE: invoice money/state at dispute-open time, so a later void
 * or refund can never rewrite what the admin reviewed.
 *
 * - 5-business-day resolution SLA on the America/Edmonton calendar
 *   (lib/business-days.ts). `scanSlaBreaches` escalates breaches via the
 *   ops-alerts service and NEVER auto-resolves — the dispute stays open
 *   until a human acts.
 * - accept: invoice → void; when the invoice was already paid, the
 *   PaymentIntent is refunded first (credit note) via StripeService.
 * - reject: invoice back to in_review with a fresh 7-day window
 *   (commission.resolveDispute 'resume').
 * - Every open/resolve/SLA-breach appends one `billing_events` row via the
 *   shared billing-audit service.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppDb } from '../../db/client';
import { billingDisputes, billingEvents, commissionInvoices } from '../../db/schema';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import {
  DISPUTE_SLA_BUSINESS_DAYS,
  DISPUTE_SLA_TIMEZONE,
  addBusinessDays,
  businessDaysBetween,
} from '../../lib/business-days';
import type {
  BillingAuditRecord,
  BillingAuditService,
} from './billing-audit.service';
/** Re-exported for route adapters (they depend on the service interface). */
export type { BillingAuditRecord } from './billing-audit.service';
import type {
  CommissionInvoiceRecord,
  CommissionService,
} from './commission.service';
import type { StripeService } from './stripe.service';
import type { OpsAlertsService } from '../ops-alerts.service';

export type DisputeStatus = 'open' | 'accepted' | 'rejected';

/**
 * Immutable invoice state captured at dispute-open time. The console
 * renders this — never the live invoice row — so the evidence can't
 * change under the admin's review.
 */
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

export interface DisputeRecord {
  readonly id: string;
  readonly invoiceId: string;
  readonly tenantKey: string;
  readonly reason: string;
  readonly evidenceSnapshot: DisputeEvidenceSnapshot;
  readonly status: DisputeStatus;
  readonly openedAt: Date;
  /** openedAt + 5 business days (America/Edmonton). */
  readonly slaDueAt: Date;
  /** When the SLA-breach ops escalation fired; null until then. */
  readonly slaBreachedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DisputeListItem extends DisputeRecord {
  /** Whole business days until slaDueAt (negative when breached). */
  readonly businessDaysRemaining: number;
  /** True when now is past slaDueAt. */
  readonly breached: boolean;
}

/** Full console detail: list item + audit trail. */
export interface DisputeDetailRecord extends DisputeListItem {
  readonly auditTrail: BillingAuditRecord[];
}

export interface ResolveDisputeInput {
  /** Admin email, for the audit trail. */
  readonly adminEmail: string;
  /** Optional human note recorded on the dispute. */
  readonly note?: string;
}

export interface DisputeService {
  /**
   * Record a dispute row for a freshly disputed invoice. Idempotent: an
   * already-open dispute for the invoice is returned unchanged.
   */
  recordOpenedDispute(
    invoice: CommissionInvoiceRecord,
    opts?: { backfilled?: boolean },
  ): Promise<DisputeRecord>;
  /**
   * Open disputes, oldest first. Lazily backfills dispute rows for
   * invoices sitting in 'disputed' with no row (e.g. disputed before this
   * table existed) so the console can never silently miss one.
   */
  listOpenDisputes(now?: Date): Promise<DisputeListItem[]>;
  /** A single dispute by id. 404 when unknown. */
  getDispute(disputeId: string): Promise<DisputeRecord>;
  /**
   * Audit trail for the console: billing_events rows for the dispute and
   * its invoice, oldest first.
   */
  getDisputeAuditTrail(disputeId: string): Promise<BillingAuditRecord[]>;
  /** Full console detail for one dispute. 404 when unknown. */
  getDisputeDetail(
    disputeId: string,
    now?: Date,
  ): Promise<DisputeDetailRecord>;
  /**
   * Accept: invoice → void. When the invoice was already paid, refund the
   * PaymentIntent first (credit note) — Stripe test mode in dev, never a
   * real charge path change. Audit-logged.
   */
  acceptDispute(
    disputeId: string,
    input: ResolveDisputeInput,
  ): Promise<DisputeRecord>;
  /**
   * Reject: invoice back to in_review with a fresh 7-day review window.
   * Audit-logged.
   */
  rejectDispute(
    disputeId: string,
    input: ResolveDisputeInput,
  ): Promise<DisputeRecord>;
  /**
   * Escalate SLA breaches: every open dispute past its slaDueAt with no
   * escalation yet gets slaBreachedAt set + one ops alert. NEVER
   * auto-resolves — the dispute stays open until a human acts.
   */
  scanSlaBreaches(now?: Date): Promise<{ escalated: number }>;
}

export interface DisputeServiceDeps {
  readonly db: AppDb;
  readonly audit: BillingAuditService;
  readonly commission: CommissionService;
  readonly stripe: StripeService;
  readonly opsAlerts: OpsAlertsService;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
  /** Defaults to node:crypto randomUUID; tests inject a fixed id. */
  readonly newId?: () => string;
}

function toRecord(
  row: typeof billingDisputes.$inferSelect,
): DisputeRecord {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    tenantKey: row.tenantKey,
    reason: row.reason,
    evidenceSnapshot: row.evidenceSnapshot as DisputeEvidenceSnapshot,
    status: row.status as DisputeStatus,
    openedAt: row.openedAt,
    slaDueAt: row.slaDueAt,
    slaBreachedAt: row.slaBreachedAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function snapshotFor(
  invoice: CommissionInvoiceRecord,
  openedAt: Date,
  backfilled: boolean,
): DisputeEvidenceSnapshot {
  return {
    invoiceId: invoice.id,
    tenantKey: invoice.tenantKey,
    attributionId: invoice.attributionId,
    leadId: invoice.leadId,
    contractValueCents: invoice.contractValueCents,
    commissionCents: invoice.commissionCents,
    currency: invoice.currency,
    stripePaymentIntentId: invoice.stripePaymentIntentId,
    status: 'disputed',
    reviewDueAt: invoice.reviewDueAt?.toISOString() ?? null,
    disputeReason: invoice.disputeReason ?? '',
    invoiceCreatedAt: invoice.createdAt.toISOString(),
    disputedAt: openedAt.toISOString(),
    ...(backfilled ? { backfilled: true as const } : {}),
  };
}

export function createDisputeService(
  deps: DisputeServiceDeps,
): DisputeService {
  const { db, audit, commission, stripe, opsAlerts } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  async function requireDispute(
    disputeId: string,
  ): Promise<typeof billingDisputes.$inferSelect> {
    const row = await db.query.billingDisputes.findFirst({
      where: eq(billingDisputes.id, disputeId),
    });
    if (row === undefined) {
      throw new HttpError(
        404,
        ErrorCodes.NOT_FOUND,
        `Dispute not found: "${disputeId}"`,
      );
    }
    return row;
  }

  function requireOpen(
    row: typeof billingDisputes.$inferSelect,
  ): void {
    if (row.status !== 'open') {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        `Dispute "${row.id}" is '${row.status}' — only 'open' disputes can be resolved`,
      );
    }
  }

  function toListItem(row: DisputeRecord, at: Date): DisputeListItem {
    return {
      ...row,
      businessDaysRemaining: businessDaysBetween(
        at,
        row.slaDueAt,
        DISPUTE_SLA_TIMEZONE,
      ),
      breached: at.getTime() > row.slaDueAt.getTime(),
    };
  }

  /**
   * Void a PAID invoice after a refund. commission.resolveDispute only
   * handles 'disputed' → void, so the paid→void leg lives here: one
   * invoice update + one audit row, mirroring the commission transition.
   */
  async function voidPaidInvoice(
    invoice: CommissionInvoiceRecord,
    disputeId: string,
    refundId: string,
  ): Promise<void> {
    await db
      .update(commissionInvoices)
      .set({ status: 'void', updatedAt: now() })
      .where(eq(commissionInvoices.id, invoice.id));
    await audit.append({
      tenantKey: invoice.tenantKey,
      eventType: 'invoice.status_changed',
      entityType: 'commission_invoice',
      entityId: invoice.id,
      payload: {
        status: 'void',
        commissionCents: invoice.commissionCents,
        from: 'paid',
        resolution: 'accept',
        creditNote: 'stripe_refund',
        refundId,
        disputeId,
      },
    });
  }

  async function resolveRow(
    row: typeof billingDisputes.$inferSelect,
    status: 'accepted' | 'rejected',
    input: ResolveDisputeInput,
  ): Promise<DisputeRecord> {
    const resolvedAt = now();
    const [updated] = await db
      .update(billingDisputes)
      .set({
        status,
        resolvedAt,
        resolvedBy: input.adminEmail,
        resolutionNote: input.note?.trim() ? input.note.trim() : null,
        updatedAt: resolvedAt,
      })
      .where(eq(billingDisputes.id, row.id))
      .returning();
    const record = toRecord(updated);
    await audit.append({
      tenantKey: record.tenantKey,
      eventType: 'dispute.resolved',
      entityType: 'billing_dispute',
      entityId: record.id,
      payload: {
        outcome: status,
        invoiceId: record.invoiceId,
        resolvedBy: input.adminEmail,
        ...(record.resolutionNote ? { note: record.resolutionNote } : {}),
      },
    });
    return record;
  }

  return {
    async recordOpenedDispute(
      invoice,
      opts,
    ): Promise<DisputeRecord> {
      const existing = await db.query.billingDisputes.findFirst({
        where: and(
          eq(billingDisputes.invoiceId, invoice.id),
          eq(billingDisputes.status, 'open'),
        ),
      });
      if (existing !== undefined) {
        return toRecord(existing);
      }
      const openedAt = now();
      const backfilled = opts?.backfilled === true;
      const [row] = await db
        .insert(billingDisputes)
        .values({
          id: newId(),
          invoiceId: invoice.id,
          tenantKey: invoice.tenantKey,
          reason: invoice.disputeReason ?? '',
          evidenceSnapshot: snapshotFor(invoice, openedAt, backfilled),
          slaDueAt: addBusinessDays(
            openedAt,
            DISPUTE_SLA_BUSINESS_DAYS,
            DISPUTE_SLA_TIMEZONE,
          ),
          openedAt,
        })
        .returning();
      const record = toRecord(row);
      await audit.append({
        tenantKey: record.tenantKey,
        eventType: 'dispute.opened',
        entityType: 'billing_dispute',
        entityId: record.id,
        payload: {
          invoiceId: record.invoiceId,
          reason: record.reason,
          slaDueAt: record.slaDueAt.toISOString(),
          ...(backfilled ? { backfilled: true } : {}),
        },
      });
      return record;
    },

    async listOpenDisputes(at?: Date): Promise<DisputeListItem[]> {
      const atTime = at ?? now();
      // Backfill: invoices sitting in 'disputed' with no dispute row can
      // never be silently dropped from the console.
      const disputedInvoices = await db.query.commissionInvoices.findMany({
        where: eq(commissionInvoices.status, 'disputed'),
      });
      for (const invoiceRow of disputedInvoices) {
        const existing = await db.query.billingDisputes.findFirst({
          where: eq(billingDisputes.invoiceId, invoiceRow.id),
        });
        if (existing === undefined) {
          const invoice = await commission.getById(invoiceRow.id);
          await this.recordOpenedDispute(invoice, { backfilled: true });
        }
      }
      const rows = await db.query.billingDisputes.findMany({
        where: eq(billingDisputes.status, 'open'),
        orderBy: asc(billingDisputes.openedAt),
      });
      return rows.map((row) => toListItem(toRecord(row), atTime));
    },

    async getDispute(disputeId: string): Promise<DisputeRecord> {
      return toRecord(await requireDispute(disputeId));
    },

    async getDisputeDetail(
      disputeId: string,
      at?: Date,
    ): Promise<DisputeDetailRecord> {
      const atTime = at ?? now();
      const record = toRecord(await requireDispute(disputeId));
      return {
        ...toListItem(record, atTime),
        auditTrail: await this.getDisputeAuditTrail(disputeId),
      };
    },

    async getDisputeAuditTrail(
      disputeId: string,
    ): Promise<BillingAuditRecord[]> {
      const row = await requireDispute(disputeId);
      const rows = await db.query.billingEvents.findMany({
        where: or(
          and(
            eq(billingEvents.entityType, 'billing_dispute'),
            eq(billingEvents.entityId, disputeId),
          ),
          and(
            eq(billingEvents.entityType, 'commission_invoice'),
            eq(billingEvents.entityId, row.invoiceId),
          ),
        ),
        orderBy: asc(billingEvents.createdAt),
      });
      return rows.map((event) => ({
        id: event.id,
        tenantKey: event.tenantKey,
        eventType: event.eventType,
        entityType: event.entityType,
        entityId: event.entityId,
        payload: (event.payload as Record<string, unknown> | null) ?? null,
        createdAt: event.createdAt,
      }));
    },

    async acceptDispute(
      disputeId,
      input,
    ): Promise<DisputeRecord> {
      const row = await requireDispute(disputeId);
      requireOpen(row);
      const invoice = await commission.getById(row.invoiceId);
      if (invoice.status === 'paid') {
        // Credit note path: refund the PaymentIntent, then void.
        if (!invoice.stripePaymentIntentId) {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            `Invoice "${invoice.id}" is 'paid' with no PaymentIntent — cannot issue a credit note`,
          );
        }
        const refund = await stripe.refundPaymentIntent(
          invoice.stripePaymentIntentId,
          `feasly:billing_disputes:${row.id}:refund`,
        );
        await voidPaidInvoice(invoice, row.id, refund.id);
      } else if (invoice.status === 'disputed') {
        await commission.resolveDispute(invoice.id, 'void');
      } else {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoice.id}" is '${invoice.status}' — only 'disputed' or 'paid' invoices can have a dispute accepted`,
        );
      }
      return resolveRow(row, 'accepted', input);
    },

    async rejectDispute(
      disputeId,
      input,
    ): Promise<DisputeRecord> {
      const row = await requireDispute(disputeId);
      requireOpen(row);
      const invoice = await commission.getById(row.invoiceId);
      if (invoice.status === 'disputed') {
        // Back to in_review with a FRESH 7-day window.
        await commission.resolveDispute(invoice.id, 'resume');
      } else if (invoice.status !== 'paid') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Invoice "${invoice.id}" is '${invoice.status}' — only 'disputed' invoices can have a dispute rejected`,
        );
        // A 'paid' invoice keeps its charge: rejecting the dispute upholds it.
      }
      return resolveRow(row, 'rejected', input);
    },

    async scanSlaBreaches(at?: Date): Promise<{ escalated: number }> {
      const atTime = at ?? now();
      const breached = await db.query.billingDisputes.findMany({
        where: and(
          eq(billingDisputes.status, 'open'),
          isNull(billingDisputes.slaBreachedAt),
          lte(billingDisputes.slaDueAt, atTime),
        ),
        orderBy: asc(billingDisputes.slaDueAt),
      });
      for (const row of breached) {
        const [updated] = await db
          .update(billingDisputes)
          .set({ slaBreachedAt: atTime, updatedAt: atTime })
          .where(eq(billingDisputes.id, row.id))
          .returning();
        const record = toRecord(updated);
        await audit.append({
          tenantKey: record.tenantKey,
          eventType: 'dispute.sla_breached',
          entityType: 'billing_dispute',
          entityId: record.id,
          payload: {
            invoiceId: record.invoiceId,
            slaDueAt: record.slaDueAt.toISOString(),
            // The dispute stays OPEN: a breach escalates, never resolves.
            autoResolved: false,
          },
        });
        await opsAlerts.notifyFailure('billing_dispute_sla_breached', {
          consecutiveFailures: 1,
          firstFailureAt: record.slaDueAt,
        });
        // Aggregates only — the alert email itself carries no PII.
      }
      return { escalated: breached.length };
    },
  };
}
