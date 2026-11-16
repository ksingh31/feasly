/**
 * Bank chargebacks + dashboard refunds (#719).
 *
 * "Disputes" inside the portal are builder invoice disputes
 * (dispute.service.ts). This service handles the other kind: a builder
 * disputing the CARD CHARGE with their bank. Stripe reports it through
 * `charge.dispute.*` webhooks; a refund issued from the Stripe dashboard
 * arrives as `charge.refunded`. The billing webhook routes those events here.
 *
 * - A chargeback is a `billing_disputes` row with `source = 'chargeback'`,
 *   keyed by the Stripe dispute id (unique), so it sits in the same admin
 *   disputes queue with the evidence deadline as its SLA. It is resolved
 *   in the Stripe dashboard, never in Feasly: the row closes when Stripe
 *   sends `charge.dispute.closed`.
 * - The invoice carries `chargeback_status`: 'open' while the dispute is
 *   live (commission.retryCharge refuses — no further charge attempts),
 *   then the outcome. A WON chargeback leaves the invoice 'paid'. A LOST
 *   chargeback (owner decision #873, 2026-11-15): the builder still owes
 *   the commission, so the invoice moves `paid → failed` and is collected
 *   again through the normal dunning queue / retry / builder pay flow, and
 *   the builder is emailed (commission.reopenAfterLostChargeback). Never
 *   auto-voided — a write-off is an admin's manual void. When re-charging
 *   the full invoice would over-collect (a partial chargeback, or the
 *   invoice was already partly refunded) or the invoice is no longer
 *   'paid', the status is left alone and ops is alerted to handle it.
 * - An open chargeback pauses nothing but charge retries on that invoice
 *   (#873): no automatic embed / lead-flow pause. The builder shows the
 *   open-chargeback flag in the admin builders list, and an admin can
 *   pause the builder by hand.
 * - `charge.refunded` mirrors Stripe's cumulative `amount_refunded` onto
 *   `commission_invoices.refunded_cents` (monotonic) with a timeline row.
 * - Every state change appends a `billing_events` row. Each handler is
 *   idempotent on terminal state, so a webhook redelivery is a no-op —
 *   and repairable: writes are not transactional, so the opened/closed
 *   timeline rows and alerts are keyed on their audit row existing, and the
 *   invoice is reconciled to a closed row's outcome, letting a redelivery
 *   finish a handler that failed partway.
 * - A PaymentIntent no invoice owns throws 404 NOT_FOUND; the webhook turns
 *   that into the orphan-PaymentIntent audit + ops alert (#711). A dispute
 *   event whose PaymentIntent was replaced by a re-collection retry still
 *   finds its invoice through the recorded chargeback row.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  ChargebackOutcome,
  DisputeEvidenceSnapshot,
} from '@feasly/contracts';
import type { AppDb } from '../../db/client';
import {
  billingDisputes,
  billingEvents,
  commissionInvoices,
} from '../../db/schema';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import {
  DISPUTE_SLA_BUSINESS_DAYS,
  DISPUTE_SLA_TIMEZONE,
  addBusinessDays,
} from '../../lib/business-days';
import type { EmailService } from '../email/email.service';
import { ensureOpsAlertDelivered } from '../ops-alerts.service';
import type { BillingAuditService } from './billing-audit.service';
import { invoiceTotalCents, type CommissionService } from './commission.service';
import type { NormalizedDispute } from './payment-provider';

/** The `charge.dispute.*` event types this service handles. */
export const CHARGEBACK_EVENT_TYPES = [
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
] as const;
export type ChargebackEventType = (typeof CHARGEBACK_EVENT_TYPES)[number];

export function isChargebackEventType(
  type: string,
): type is ChargebackEventType {
  return (CHARGEBACK_EVENT_TYPES as readonly string[]).includes(type);
}

const CLOSED_OUTCOMES: ReadonlySet<string> = new Set<ChargebackOutcome>([
  'won',
  'lost',
  'warning_closed',
]);

export interface ChargebackEventInput {
  readonly eventId: string;
  readonly eventType: ChargebackEventType;
  readonly paymentIntentId: string;
  readonly dispute: NormalizedDispute;
}

export interface ChargebackEventResult {
  readonly disputeId: string;
  readonly invoiceId: string;
  /** False when the event changed nothing (redelivery / stale update). */
  readonly changed: boolean;
}

export interface ChargeRefundInput {
  readonly eventId: string;
  readonly paymentIntentId: string;
  /** Stripe's cumulative `charge.amount_refunded`, integer cents. */
  readonly amountRefundedCents: number;
}

export interface ChargeRefundResult {
  readonly invoiceId: string;
  readonly refundedCents: number;
  readonly changed: boolean;
}

export interface ChargebackService {
  /** Apply one `charge.dispute.*` event. 404 when no invoice owns the PI. */
  handleDisputeEvent(input: ChargebackEventInput): Promise<ChargebackEventResult>;
  /** Apply one `charge.refunded` event. 404 when no invoice owns the PI. */
  recordChargeRefund(input: ChargeRefundInput): Promise<ChargeRefundResult>;
}

export interface ChargebackServiceDeps {
  readonly db: AppDb;
  readonly audit: BillingAuditService;
  /** #873: a lost chargeback re-opens the invoice for collection. */
  readonly commission: Pick<CommissionService, 'reopenAfterLostChargeback'>;
  readonly email: Pick<EmailService, 'sendOpsAlert'>;
  readonly opsInbox: string;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
  /** Defaults to node:crypto randomUUID; tests inject a fixed id. */
  readonly newId?: () => string;
  /** Warning sink for best-effort alert failures. Defaults to console.warn. */
  readonly logWarning?: (message: string) => void;
}

type InvoiceRow = typeof commissionInvoices.$inferSelect;
type DisputeRow = typeof billingDisputes.$inferSelect;

function formatCents(cents: number | null, currency: string): string {
  if (cents === null) return 'an unknown amount';
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function formatDeadline(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPUTE_SLA_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function snapshotFor(
  invoice: InvoiceRow,
  openedAt: Date,
  reason: string,
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
    status: invoice.status as DisputeEvidenceSnapshot['status'],
    reviewDueAt: invoice.reviewDueAt?.toISOString() ?? null,
    disputeReason: reason,
    invoiceCreatedAt: invoice.createdAt.toISOString(),
    disputedAt: openedAt.toISOString(),
  };
}

export function createChargebackService(
  deps: ChargebackServiceDeps,
): ChargebackService {
  const { db, audit, commission, email, opsInbox } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const logWarning =
    deps.logWarning ?? ((message: string) => console.warn(message));

  async function requireInvoiceByPaymentIntent(
    paymentIntentId: string,
  ): Promise<InvoiceRow> {
    const row = await db.query.commissionInvoices.findFirst({
      where: eq(commissionInvoices.stripePaymentIntentId, paymentIntentId),
    });
    if (row === undefined) {
      throw new HttpError(
        404,
        ErrorCodes.NOT_FOUND,
        `No commission invoice for PaymentIntent "${paymentIntentId}"`,
      );
    }
    return row;
  }

  /**
   * The invoice a dispute event belongs to. A lost chargeback's
   * re-collection retry gives the invoice a fresh PaymentIntent, so a late
   * event for the original charge falls back to the chargeback row already
   * recorded for this Stripe dispute.
   */
  async function requireInvoiceForDispute(
    paymentIntentId: string,
    stripeDisputeId: string,
  ): Promise<InvoiceRow> {
    try {
      return await requireInvoiceByPaymentIntent(paymentIntentId);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      const known = await db.query.billingDisputes.findFirst({
        columns: { invoiceId: true },
        where: eq(billingDisputes.stripeDisputeId, stripeDisputeId),
      });
      if (known === undefined) throw error;
      const row = await db.query.commissionInvoices.findFirst({
        where: eq(commissionInvoices.id, known.invoiceId),
      });
      if (row === undefined) throw error;
      return row;
    }
  }

  /**
   * True when re-charging the whole invoice collects exactly what the lost
   * chargeback took back. A partial chargeback or an invoice that was
   * already (partly) refunded would be over-collected — ops handles those.
   */
  function canRecollectInFull(invoice: InvoiceRow, chargebackCents: number | null): boolean {
    if (invoice.refundedCents > 0) return false;
    return chargebackCents === null || chargebackCents === invoiceTotalCents(invoice);
  }

  /**
   * Best-effort ops alert: the webhook event is acknowledged either way.
   * Throwing would leave the event unprocessed and the redelivery would
   * find nothing left to alert about.
   */
  async function alertOps(title: string, summary: string): Promise<void> {
    try {
      const delivery = await email.sendOpsAlert({
        to: opsInbox,
        title,
        summary,
        firedAt: now(),
      });
      ensureOpsAlertDelivered(delivery, title, logWarning);
    } catch (error) {
      logWarning(
        `chargeback: ops alert "${title}" not delivered ` +
          `(${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
  }

  /**
   * True when an audit row of this type exists for the entity (optionally
   * narrowed by one payload field). Used to make multi-step writes
   * repairable: the services write without a transaction, so a redelivery
   * after a mid-handler failure re-checks each step instead of trusting
   * that an earlier, already-applied state change finished the rest.
   */
  async function hasAudit(
    eventType: string,
    entityType: string,
    entityId: string,
    payloadMatch?: { key: string; value: string },
  ): Promise<boolean> {
    const existing = await db.query.billingEvents.findFirst({
      columns: { id: true },
      where: and(
        eq(billingEvents.eventType, eventType),
        eq(billingEvents.entityType, entityType),
        eq(billingEvents.entityId, entityId),
        payloadMatch === undefined
          ? undefined
          : sql`${billingEvents.payload}->>${payloadMatch.key} = ${payloadMatch.value}`,
      ),
    });
    return existing !== undefined;
  }

  /** One audit row per Stripe event — skipped when it already exists. */
  async function appendOnce(
    tenantKey: string,
    eventType: string,
    entityType: string,
    entityId: string,
    stripeEventId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    if (
      await hasAudit(eventType, entityType, entityId, {
        key: 'stripeEventId',
        value: stripeEventId,
      })
    ) {
      return false;
    }
    await audit.append({
      tenantKey,
      eventType,
      entityType,
      entityId,
      payload: { ...payload, stripeEventId },
    });
    return true;
  }

  /**
   * Find the chargeback row for a Stripe dispute, creating it on first
   * sight. Any dispute event can arrive first (Stripe does not guarantee
   * order), so every event type upserts.
   */
  async function upsertChargeback(
    invoice: InvoiceRow,
    input: ChargebackEventInput,
  ): Promise<{ row: DisputeRow; created: boolean }> {
    const { dispute } = input;
    const existing = await db.query.billingDisputes.findFirst({
      where: eq(billingDisputes.stripeDisputeId, dispute.id),
    });
    if (existing !== undefined) return { row: existing, created: false };
    const openedAt = now();
    const reason = dispute.reason ?? 'chargeback';
    const [inserted] = await db
      .insert(billingDisputes)
      .values({
        id: newId(),
        invoiceId: invoice.id,
        tenantKey: invoice.tenantKey,
        reason,
        evidenceSnapshot: snapshotFor(invoice, openedAt, reason),
        status: 'open',
        openedAt,
        // The evidence deadline IS the SLA. Stripe always sends one for a
        // needs_response dispute; inquiries without one fall back to the
        // standard 5-business-day window so the queue still counts down.
        slaDueAt:
          dispute.evidenceDueAt ??
          addBusinessDays(openedAt, DISPUTE_SLA_BUSINESS_DAYS, DISPUTE_SLA_TIMEZONE),
        source: 'chargeback',
        stripeDisputeId: dispute.id,
        stripeReason: dispute.reason,
        stripeStatus: dispute.status,
        amountCents: dispute.amountCents,
        evidenceDueAt: dispute.evidenceDueAt,
        livemode: dispute.livemode,
      })
      .onConflictDoNothing({ target: billingDisputes.stripeDisputeId })
      .returning();
    if (inserted !== undefined) return { row: inserted, created: true };
    // Lost a race with a concurrent delivery — use the winner's row.
    const winner = await db.query.billingDisputes.findFirst({
      where: eq(billingDisputes.stripeDisputeId, dispute.id),
    });
    if (winner === undefined) {
      throw new Error(`chargeback: dispute ${dispute.id} vanished after insert`);
    }
    return { row: winner, created: false };
  }

  /** Copy Stripe's latest dispute fields onto the row; true when changed. */
  async function syncStripeFields(
    row: DisputeRow,
    dispute: NormalizedDispute,
  ): Promise<{ row: DisputeRow; changed: boolean }> {
    // A closed chargeback is final: a late, out-of-order event (e.g. an
    // `updated` with status 'under_review') must not rewrite its Stripe
    // status, amount or deadline after the outcome was recorded.
    if (row.status !== 'open') return { row, changed: false };
    const patch: Partial<typeof billingDisputes.$inferInsert> = {};
    if (dispute.status !== null && dispute.status !== row.stripeStatus) {
      patch.stripeStatus = dispute.status;
    }
    if (dispute.reason !== null && dispute.reason !== row.stripeReason) {
      patch.stripeReason = dispute.reason;
    }
    if (dispute.amountCents !== null && dispute.amountCents !== row.amountCents) {
      patch.amountCents = dispute.amountCents;
    }
    if (
      dispute.evidenceDueAt !== null &&
      dispute.evidenceDueAt.getTime() !== row.evidenceDueAt?.getTime()
    ) {
      patch.evidenceDueAt = dispute.evidenceDueAt;
      // A still-open chargeback's SLA follows the evidence deadline.
      if (row.status === 'open') patch.slaDueAt = dispute.evidenceDueAt;
    }
    if (Object.keys(patch).length === 0) return { row, changed: false };
    const [updated] = await db
      .update(billingDisputes)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(billingDisputes.id, row.id), eq(billingDisputes.status, 'open')))
      .returning();
    if (updated === undefined) {
      // Closed concurrently — leave it; re-read so callers see the outcome.
      const fresh = await db.query.billingDisputes.findFirst({
        where: eq(billingDisputes.id, row.id),
      });
      return { row: fresh ?? row, changed: false };
    }
    return { row: updated, changed: true };
  }

  /** Flag the invoice as under chargeback (no-op when already flagged). */
  async function flagInvoiceOpen(
    invoice: InvoiceRow,
    row: DisputeRow,
    stripeEventId: string,
  ): Promise<boolean> {
    const [updated] = await db
      .update(commissionInvoices)
      .set({ chargebackStatus: 'open', updatedAt: now() })
      .where(
        and(
          eq(commissionInvoices.id, invoice.id),
          or(
            isNull(commissionInvoices.chargebackStatus),
            ne(commissionInvoices.chargebackStatus, 'open'),
          ),
        ),
      )
      .returning({ id: commissionInvoices.id });
    if (updated === undefined) return false;
    await audit.append({
      tenantKey: invoice.tenantKey,
      eventType: 'invoice.chargeback_opened',
      entityType: 'commission_invoice',
      entityId: invoice.id,
      payload: {
        status: invoice.status,
        chargebackStatus: 'open',
        disputeId: row.id,
        stripeDisputeId: row.stripeDisputeId,
        amountCents: row.amountCents,
        reason: row.stripeReason,
        evidenceDueAt: row.evidenceDueAt?.toISOString() ?? null,
        stripeEventId,
      },
    });
    return true;
  }

  async function closeChargeback(
    invoice: InvoiceRow,
    row: DisputeRow,
    outcome: ChargebackOutcome,
    stripeEventId: string,
  ): Promise<boolean> {
    const resolvedAt = now();
    // Each step below is checked on its own so a redelivery after a
    // mid-handler failure finishes the work: the dispute row closing first
    // must not strand the invoice at chargeback_status='open' (which would
    // block retryCharge forever and swallow the won/lost alert).
    // Conditional on 'open': a redelivered close finds nothing to update.
    const [justClosed] = await db
      .update(billingDisputes)
      .set({
        status: 'closed',
        outcome,
        resolvedAt,
        resolvedBy: 'stripe',
        updatedAt: resolvedAt,
      })
      .where(and(eq(billingDisputes.id, row.id), eq(billingDisputes.status, 'open')))
      .returning();
    let closed: DisputeRow | undefined = justClosed;
    if (closed === undefined) {
      closed = await db.query.billingDisputes.findFirst({
        where: eq(billingDisputes.id, row.id),
      });
      if (closed === undefined || closed.status !== 'closed') return false;
    }
    // An already-closed row keeps the outcome it was closed with.
    const finalOutcome = (closed.outcome ?? outcome) as ChargebackOutcome;
    let changed = justClosed !== undefined;

    if (!(await hasAudit('chargeback.closed', 'billing_dispute', row.id))) {
      await audit.append({
        tenantKey: row.tenantKey,
        eventType: 'chargeback.closed',
        entityType: 'billing_dispute',
        entityId: row.id,
        payload: {
          outcome: finalOutcome,
          invoiceId: row.invoiceId,
          stripeDisputeId: row.stripeDisputeId,
          amountCents: closed.amountCents,
          stripeEventId,
        },
      });
      changed = true;
    }

    const [reconciled] = await db
      .update(commissionInvoices)
      .set({ chargebackStatus: finalOutcome, updatedAt: resolvedAt })
      .where(
        and(
          eq(commissionInvoices.id, invoice.id),
          sql`${commissionInvoices.chargebackStatus} IS DISTINCT FROM ${finalOutcome}`,
        ),
      )
      .returning({ id: commissionInvoices.id });
    if (reconciled !== undefined) changed = true;

    // #873: a lost chargeback re-opens the invoice for collection. Runs on
    // every delivery (idempotent per dispute) so a redelivery finishes a
    // move that failed partway, before the keyed timeline row below.
    let recollecting = false;
    if (finalOutcome === 'lost' && canRecollectInFull(invoice, closed.amountCents)) {
      const { reopened } = await commission.reopenAfterLostChargeback({
        invoiceId: invoice.id,
        disputeId: row.id,
        stripeDisputeId: row.stripeDisputeId,
        stripeEventId,
      });
      if (reopened) changed = true;
      const fresh = await db.query.commissionInvoices.findFirst({
        columns: { status: true },
        where: eq(commissionInvoices.id, invoice.id),
      });
      recollecting = fresh?.status === 'failed';
    }

    // The invoice timeline row + ops alert are keyed on this dispute, not on
    // the transition above, so they are written even when the invoice was
    // reconciled by an earlier, partially failed delivery.
    if (
      await hasAudit('invoice.chargeback_closed', 'commission_invoice', invoice.id, {
        key: 'disputeId',
        value: row.id,
      })
    ) {
      return changed;
    }
    const amount = formatCents(closed.amountCents, invoice.currency);
    // Alert before the audit row: if the audit write fails, the redelivery
    // alerts again (at-least-once) rather than never.
    if (finalOutcome === 'lost' && recollecting) {
      await alertOps(
        `Chargeback lost on ${invoice.invoiceNumber} — commission due again`,
        `Stripe closed chargeback ${row.stripeDisputeId} on invoice ` +
          `${invoice.invoiceNumber} as LOST (${amount}). The builder still ` +
          `owes the commission: the invoice is now 'failed' and in the ` +
          `dunning queue, and the builder has been emailed. Retry the charge ` +
          `from the dunning queue, or void the invoice by hand to write it off.`,
      );
    } else if (finalOutcome === 'lost') {
      await alertOps(
        `Chargeback lost on ${invoice.invoiceNumber} — manual follow-up`,
        `Stripe closed chargeback ${row.stripeDisputeId} on invoice ` +
          `${invoice.invoiceNumber} as LOST (${amount}). It was not re-opened ` +
          `for collection automatically (invoice status '${invoice.status}', ` +
          `refunded ${formatCents(invoice.refundedCents, invoice.currency)}): ` +
          `re-charging the full invoice could over-collect. Decide the amount ` +
          `still owed and collect or void it by hand.`,
      );
    } else {
      await alertOps(
        `Chargeback closed on ${invoice.invoiceNumber}: ${finalOutcome.replace('_', ' ')}`,
        `Stripe closed chargeback ${row.stripeDisputeId} on invoice ` +
          `${invoice.invoiceNumber} (${amount}) with outcome ` +
          `'${finalOutcome}'. No action needed.`,
      );
    }
    await audit.append({
      tenantKey: invoice.tenantKey,
      eventType: 'invoice.chargeback_closed',
      entityType: 'commission_invoice',
      entityId: invoice.id,
      payload: {
        // won / warning_closed → the status is unchanged (stays paid);
        // lost → 'failed' when re-opened for collection (#873), otherwise
        // unchanged and flagged for manual follow-up.
        status: recollecting ? 'failed' : invoice.status,
        chargebackStatus: finalOutcome,
        disputeId: row.id,
        stripeDisputeId: row.stripeDisputeId,
        ...(finalOutcome === 'lost'
          ? recollecting
            ? { recollect: true }
            : { manualFollowUpRequired: true }
          : {}),
        stripeEventId,
      },
    });
    return true;
  }

  /**
   * The opened timeline row + evidence-deadline alert (AC1). Keyed on the
   * audit row existing, not on the insert, so a failure anywhere after the
   * chargeback row is created is repaired by the next delivery for this
   * dispute. Alert first: a failed audit write re-alerts on redelivery
   * (at-least-once) instead of losing the deadline.
   */
  async function ensureOpenedRecorded(
    invoice: InvoiceRow,
    row: DisputeRow,
    stripeEventId: string,
  ): Promise<boolean> {
    if (await hasAudit('chargeback.opened', 'billing_dispute', row.id)) return false;
    if (row.status === 'open') {
      const deadline = row.evidenceDueAt
        ? formatDeadline(row.evidenceDueAt)
        : 'not set by Stripe';
      await alertOps(
        `Chargeback opened on ${invoice.invoiceNumber} — evidence due ${deadline}`,
        `A bank chargeback (${row.stripeReason ?? 'no reason given'}) was ` +
          `opened against invoice ${invoice.invoiceNumber} for ` +
          `${formatCents(row.amountCents, invoice.currency)}. Stripe dispute ` +
          `${row.stripeDisputeId}. Evidence is due ${deadline} (America/Edmonton) ` +
          `— submit it in the Stripe dashboard. Further charges on this ` +
          `invoice are paused until Stripe closes the dispute. The builder's ` +
          `embed and leads keep running; pause the builder by hand if needed.`,
      );
    }
    await audit.append({
      tenantKey: row.tenantKey,
      eventType: 'chargeback.opened',
      entityType: 'billing_dispute',
      entityId: row.id,
      payload: {
        invoiceId: row.invoiceId,
        stripeDisputeId: row.stripeDisputeId,
        reason: row.stripeReason,
        amountCents: row.amountCents,
        evidenceDueAt: row.evidenceDueAt?.toISOString() ?? null,
        stripeEventId,
      },
    });
    return true;
  }

  return {
    async handleDisputeEvent(input): Promise<ChargebackEventResult> {
      const invoice = await requireInvoiceForDispute(
        input.paymentIntentId,
        input.dispute.id,
      );
      const { row: initial, created } = await upsertChargeback(invoice, input);
      let row = initial;
      let changed = created;

      if (!created) {
        const synced = await syncStripeFields(row, input.dispute);
        row = synced.row;
        if (synced.changed && input.eventType === 'charge.dispute.updated') {
          changed = true;
          await appendOnce(
            row.tenantKey,
            'chargeback.updated',
            'billing_dispute',
            row.id,
            input.eventId,
            {
              invoiceId: row.invoiceId,
              stripeStatus: row.stripeStatus,
              evidenceDueAt: row.evidenceDueAt?.toISOString() ?? null,
            },
          );
        }
      }

      changed = (await ensureOpenedRecorded(invoice, row, input.eventId)) || changed;

      // A closed chargeback is never re-opened by a late, out-of-order event.
      if (row.status === 'open') {
        changed = (await flagInvoiceOpen(invoice, row, input.eventId)) || changed;
      }

      switch (input.eventType) {
        case 'charge.dispute.funds_withdrawn':
        case 'charge.dispute.funds_reinstated':
          changed =
            (await appendOnce(
              row.tenantKey,
              input.eventType === 'charge.dispute.funds_withdrawn'
                ? 'chargeback.funds_withdrawn'
                : 'chargeback.funds_reinstated',
              'billing_dispute',
              row.id,
              input.eventId,
              {
                invoiceId: row.invoiceId,
                stripeDisputeId: row.stripeDisputeId,
                amountCents: row.amountCents,
              },
            )) || changed;
          break;
        case 'charge.dispute.closed': {
          const status = input.dispute.status ?? '';
          if (!CLOSED_OUTCOMES.has(status)) {
            logWarning(
              `chargeback: ${input.eventId} closed dispute ${input.dispute.id} ` +
                `with unexpected status '${status}' — left open for ops`,
            );
            break;
          }
          changed =
            (await closeChargeback(
              invoice,
              row,
              status as ChargebackOutcome,
              input.eventId,
            )) || changed;
          break;
        }
        default:
          break;
      }
      return { disputeId: row.id, invoiceId: invoice.id, changed };
    },

    async recordChargeRefund(input): Promise<ChargeRefundResult> {
      const invoice = await requireInvoiceByPaymentIntent(input.paymentIntentId);
      const amount = input.amountRefundedCents;
      if (!Number.isInteger(amount) || amount <= invoice.refundedCents) {
        // Stripe's figure is cumulative: equal = redelivery, lower = stale.
        return { invoiceId: invoice.id, refundedCents: invoice.refundedCents, changed: false };
      }
      // Monotonic: a concurrent, larger refund already recorded wins.
      const [updated] = await db
        .update(commissionInvoices)
        .set({ refundedCents: amount, updatedAt: now() })
        .where(
          and(
            eq(commissionInvoices.id, invoice.id),
            lt(commissionInvoices.refundedCents, amount),
          ),
        )
        .returning();
      if (updated === undefined) {
        return { invoiceId: invoice.id, refundedCents: invoice.refundedCents, changed: false };
      }
      const totalCents = invoiceTotalCents(updated);
      await audit.append({
        tenantKey: invoice.tenantKey,
        eventType: 'invoice.refunded',
        entityType: 'commission_invoice',
        entityId: invoice.id,
        payload: {
          status: updated.status,
          refundedCents: amount,
          deltaCents: amount - invoice.refundedCents,
          totalCents,
          fullyRefunded: amount >= totalCents,
          source: 'stripe',
          stripeEventId: input.eventId,
        },
      });
      return { invoiceId: invoice.id, refundedCents: amount, changed: true };
    },
  };
}
