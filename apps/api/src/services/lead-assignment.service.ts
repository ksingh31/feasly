/**
 * Lead assignment + reassignment rules (#721).
 *
 * `POST /api/v1/admin/leads/{id}/assign-builder` used to update
 * `leads.builder_id` only, leaving the old builder's attribution and invoice
 * behind. This service owns the rules (owner decision 2026-11-15):
 *
 * - Unassigned → builder B: assign (unchanged behaviour). B's introduction
 *   is still recorded by the won flow, as before.
 * - Builder A → B, or A → unassigned:
 *   - any non-void commission invoice on the lead → 409 LEAD_HAS_INVOICE
 *     naming the invoice. Unpaid (draft / in_review / failed): void it
 *     first. Charged or in flight (finalized / paid / disputed): refund or
 *     resolve it first. Nothing moves.
 *   - A has a recorded contract with no invoice → 409 CONFLICT (the
 *     contract must be corrected first; the move would orphan it).
 *   - otherwise, in one transaction: A's open introduction closes as
 *     'reassigned' (nothing billable to A), the lead moves (tenant_key
 *     follows the builder, status resets to 'new' so B sees it in "Needs
 *     you"), a `lead_reassignments` row records the move, and B gets a
 *     fresh introduction dated now. Audit rows are written for both
 *     tenants.
 * - A sees the lead marked "Reassigned by Feasly" (no reason, no email);
 *   detail and comments already 404 for A because the portal scopes reads
 *   by builder_id.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts. No homeowner PII in logs or audit details.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  BuilderReassignedLead,
  LeadAssignBuilderResponse,
} from '@feasly/contracts';
import type { AppDb } from '../db/client';
import {
  attributionEvents,
  builders,
  commissionInvoices,
  leadReassignments,
  leadStatusHistory,
  leads,
} from '../db/schema';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';

export interface LeadReassignmentEntry {
  readonly fromBuilderId: string | null;
  readonly toBuilderId: string | null;
  readonly actorEmail: string;
  readonly reassignedAt: Date;
}

export interface LeadAssignmentService {
  /**
   * Assign (builderId) or unassign (null) a lead, enforcing the #721
   * reassignment rules. 404 when the lead or builder doesn't exist; 409
   * LEAD_HAS_INVOICE when the lead has a non-void invoice; 409 CONFLICT
   * when a recorded contract has no invoice or the assignment changed
   * concurrently. Assigning to the current builder is a no-op.
   */
  assignLead(
    leadId: string,
    builderId: string | null,
    adminEmail: string,
  ): Promise<LeadAssignBuilderResponse>;
  /**
   * Leads moved away from this builder that are not currently assigned
   * back to it, newest move first. Name only — no contact details.
   */
  listReassignedAway(
    builderId: string,
    limit?: number,
  ): Promise<readonly BuilderReassignedLead[]>;
  /** Every reassignment of one lead, oldest first (admin lead history). */
  listForLead(leadId: string): Promise<readonly LeadReassignmentEntry[]>;
}

export interface LeadAssignmentServiceDeps {
  readonly db: AppDb;
  readonly audit: AdminAuditStore;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
  /** Defaults to node:crypto randomUUID. */
  readonly newId?: () => string;
}

/** Matches the lead store's default list cap (listByBuilderId). */
const DEFAULT_REASSIGNED_LIMIT = 100;

/** Invoice statuses that block a move with "void it first". */
const UNPAID_INVOICE_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'in_review',
  'failed',
]);

function invoiceBlockMessage(invoiceNumber: string, status: string): string {
  if (UNPAID_INVOICE_STATUSES.has(status)) {
    return (
      `This lead has unpaid invoice ${invoiceNumber} (${status}) with its current builder. ` +
      'Void the invoice before reassigning the lead.'
    );
  }
  if (status === 'disputed') {
    return (
      `This lead has invoice ${invoiceNumber} under dispute with its current builder. ` +
      'Resolve the dispute and void or refund the invoice before reassigning the lead.'
    );
  }
  return (
    `This lead has invoice ${invoiceNumber} (${status}) that has been charged or is being charged. ` +
    'Refund the invoice before reassigning the lead.'
  );
}

export function createLeadAssignmentService(
  deps: LeadAssignmentServiceDeps,
): LeadAssignmentService {
  const { db, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  async function requireBuilder(id: string) {
    const row = await db.query.builders.findFirst({ where: eq(builders.id, id) });
    if (row === undefined) {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.', false);
    }
    return row;
  }

  return {
    async assignLead(leadId, builderId, adminEmail): Promise<LeadAssignBuilderResponse> {
      const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
      if (lead === undefined) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }
      const target = builderId === null ? null : await requireBuilder(builderId);
      const fromBuilderId = lead.builderId;

      if (fromBuilderId === builderId) {
        return { ok: true, changed: false, fromBuilderId, toBuilderId: builderId };
      }

      if (fromBuilderId === null) {
        // First assignment: nothing to move away from. tenant_key follows
        // the builder (the deploy-time repair SQL aligns it the same way).
        await db
          .update(leads)
          .set({ builderId, tenantKey: target!.tenantKey, updatedAt: now() })
          .where(eq(leads.id, leadId));
        await audit.log({
          actorEmail: adminEmail,
          action: 'admin_lead_builder_assigned',
          detail: `leadId=${leadId} builderId=${builderId} tenantKey=${target!.tenantKey}`,
        });
        return { ok: true, changed: true, fromBuilderId, toBuilderId: builderId };
      }

      const fromBuilder = await db.query.builders.findFirst({
        where: eq(builders.id, fromBuilderId),
      });
      // The FK is ON DELETE SET NULL, so the old builder exists; fall back
      // to the lead's own tenant key defensively.
      const fromTenantKey = fromBuilder?.tenantKey ?? lead.tenantKey;
      const at = now();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.transaction(async (tx: any) => {
        // Lock the lead so a concurrent assign or status change serializes
        // behind this move.
        const [locked] = await tx
          .select({ builderId: leads.builderId, status: leads.status })
          .from(leads)
          .where(eq(leads.id, leadId))
          .for('update');
        if (locked === undefined || locked.builderId !== fromBuilderId) {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            'The lead was reassigned by someone else. Reload and try again.',
            false,
          );
        }

        const invoices: {
          id: string;
          invoiceNumber: string;
          status: string;
          attributionId: string;
        }[] = await tx
          .select({
            id: commissionInvoices.id,
            invoiceNumber: commissionInvoices.invoiceNumber,
            status: commissionInvoices.status,
            attributionId: commissionInvoices.attributionId,
          })
          .from(commissionInvoices)
          .where(eq(commissionInvoices.leadId, leadId))
          .orderBy(desc(commissionInvoices.createdAt));
        const blocking = invoices.find((invoice) => invoice.status !== 'void');
        if (blocking !== undefined) {
          throw new HttpError(
            409,
            ErrorCodes.LEAD_HAS_INVOICE,
            invoiceBlockMessage(blocking.invoiceNumber, blocking.status),
            false,
          );
        }

        if (fromTenantKey !== null) {
          // A recorded contract always gets an invoice; one without (even a
          // void one) means billing is mid-flight, so refuse the move.
          const invoiced = new Set(invoices.map((invoice) => invoice.attributionId));
          const attributed: { id: string }[] = await tx
            .select({ id: attributionEvents.id })
            .from(attributionEvents)
            .where(
              and(
                eq(attributionEvents.leadId, leadId),
                eq(attributionEvents.tenantKey, fromTenantKey),
                eq(attributionEvents.status, 'attributed'),
              ),
            );
          if (attributed.some((row) => !invoiced.has(row.id))) {
            throw new HttpError(
              409,
              ErrorCodes.CONFLICT,
              'The current builder has recorded a signed contract for this lead but no invoice exists yet. ' +
                'Correct the contract before reassigning the lead.',
              false,
            );
          }

          // Close the old builder's open introduction: nothing billable.
          await tx
            .update(attributionEvents)
            .set({ status: 'reassigned', updatedAt: at })
            .where(
              and(
                eq(attributionEvents.leadId, leadId),
                eq(attributionEvents.tenantKey, fromTenantKey),
                eq(attributionEvents.status, 'introduced'),
              ),
            );
        }

        await tx
          .update(leads)
          .set({
            builderId,
            tenantKey: target === null ? null : target.tenantKey,
            status: 'new',
            updatedAt: at,
          })
          .where(eq(leads.id, leadId));
        if (locked.status !== 'new') {
          await tx.insert(leadStatusHistory).values({
            id: newId(),
            leadId,
            oldStatus: locked.status,
            newStatus: 'new',
            changedBy: adminEmail,
            changedAt: at,
          });
        }

        await tx.insert(leadReassignments).values({
          id: newId(),
          leadId,
          fromBuilderId,
          toBuilderId: builderId,
          actorEmail: adminEmail,
          reassignedAt: at,
        });

        if (target !== null) {
          // The new builder's introduction starts now. An open one already
          // there (UNIQUE open lead+tenant, migration 0034) is kept.
          await tx
            .insert(attributionEvents)
            .values({
              id: newId(),
              leadId,
              tenantKey: target.tenantKey,
              introducedAt: at,
              status: 'introduced',
            })
            .onConflictDoNothing();
        }
      });

      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_lead_reassigned_away',
        detail:
          `leadId=${leadId} builderId=${fromBuilderId} tenantKey=${fromTenantKey ?? 'null'} ` +
          `toBuilderId=${builderId ?? 'null'}`,
      });
      await audit.log({
        actorEmail: adminEmail,
        action: target === null ? 'admin_lead_builder_unassigned' : 'admin_lead_builder_assigned',
        detail:
          target === null
            ? `leadId=${leadId} builderId=null fromBuilderId=${fromBuilderId}`
            : `leadId=${leadId} builderId=${target.id} tenantKey=${target.tenantKey} fromBuilderId=${fromBuilderId}`,
      });
      return { ok: true, changed: true, fromBuilderId, toBuilderId: builderId };
    },

    async listReassignedAway(builderId, limit = DEFAULT_REASSIGNED_LIMIT) {
      const rows = await db
        .select({
          id: leads.id,
          name: leads.name,
          reassignedAt: sql<Date>`max(${leadReassignments.reassignedAt})`,
        })
        .from(leadReassignments)
        .innerJoin(leads, eq(leads.id, leadReassignments.leadId))
        .where(
          and(
            eq(leadReassignments.fromBuilderId, builderId),
            // Moved back to this builder → it's a normal lead again.
            sql`${leads.builderId} IS DISTINCT FROM ${builderId}`,
            eq(leads.discarded, false),
          ),
        )
        .groupBy(leads.id, leads.name)
        .orderBy(desc(sql`max(${leadReassignments.reassignedAt})`))
        .limit(limit);
      return rows.map((row: { id: string; name: string; reassignedAt: Date | string }) => ({
        id: row.id,
        name: row.name,
        reassignedAt: new Date(row.reassignedAt).toISOString(),
      }));
    },

    async listForLead(leadId) {
      const rows = await db
        .select()
        .from(leadReassignments)
        .where(eq(leadReassignments.leadId, leadId))
        .orderBy(leadReassignments.reassignedAt);
      return rows.map((row: typeof leadReassignments.$inferSelect) => ({
        fromBuilderId: row.fromBuilderId,
        toBuilderId: row.toBuilderId,
        actorEmail: row.actorEmail,
        reassignedAt: row.reassignedAt,
      }));
    },
  };
}
