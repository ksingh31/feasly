/**
 * Builder leads service (embed/09).
 *
 * Tenant-scoped lead pipeline for the builder portal:
 * - `listLeads(tenantKey)` — all leads for the builder's tenant, newest
 *   first, with a won/lost summary. Quarantined rows are excluded.
 * - `updateStatus(id, body, tenantKey, builderEmail)` — pipeline status
 *   transition. The lead MUST belong to the builder's tenant, otherwise
 *   403 (AC1: cross-tenant reads are forbidden). Writes
 *   `lead_status_history` (append-only, for the attribution track) + audit
 *   row with the builder's email.
 *
 * Tenant isolation is enforced at the service layer: every read filters by
 * tenant_key at the database level, and every write re-verifies the lead's
 * tenant before touching it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  BuilderLeadListItem,
  BuilderLeadListResponse,
  BuilderLeadStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import type { LeadStore } from './lead.store';

export const BuilderLeadStatusSchema = z.enum([
  'new',
  'contacted',
  'quoted',
  'won',
  'lost',
]);

export const BuilderLeadStatusBodySchema = z.object({
  status: BuilderLeadStatusSchema,
});

export interface BuilderLeadsService {
  /**
   * List the builder's leads (tenant-scoped) with a pipeline summary.
   * Only leads with matching tenant_key are returned.
   */
  listLeads(tenantKey: string): Promise<BuilderLeadListResponse>;
  /**
   * Transition a lead's pipeline status. Throws 404 when the lead doesn't
   * exist, 403 when it belongs to a different tenant. Writes
   * `lead_status_history` + audit row with the builder's email.
   */
  updateStatus(
    id: string,
    body: unknown,
    tenantKey: string,
    builderEmail: string,
  ): Promise<{ readonly ok: true }>;
}

export interface BuilderLeadsServiceDeps {
  readonly leadStore: LeadStore;
  readonly audit: AdminAuditStore;
  readonly clock?: () => Date;
}

function toListItem(record: {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly timeline: string;
  readonly leadScore: number;
  readonly status: string;
  readonly addressKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): BuilderLeadListItem {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    phone: record.phone,
    timeline: record.timeline,
    leadScore: record.leadScore,
    status: record.status as BuilderLeadStatus,
    statusUpdatedAt: record.updatedAt.toISOString(),
    addressKey: record.addressKey,
    // projectType is denormalized from the estimate; the list item carries
    // the address key and the detail view resolves the full estimate.
    projectType: '',
    createdAt: record.createdAt.toISOString(),
  };
}

export function createBuilderLeadsService(
  deps: BuilderLeadsServiceDeps,
): BuilderLeadsService {
  const { leadStore, audit } = deps;

  return {
    async listLeads(tenantKey: string): Promise<BuilderLeadListResponse> {
      const records = await leadStore.listByTenantKey({ tenantKey });

      const summary = {
        total: records.length,
        new: 0,
        contacted: 0,
        quoted: 0,
        won: 0,
        lost: 0,
      };
      for (const record of records) {
        switch (record.status) {
          case 'new':
            summary.new++;
            break;
          case 'contacted':
            summary.contacted++;
            break;
          case 'quoted':
            summary.quoted++;
            break;
          case 'won':
            summary.won++;
            break;
          case 'lost':
            summary.lost++;
            break;
        }
      }

      return {
        leads: records.map(toListItem),
        summary,
      };
    },

    async updateStatus(
      id: string,
      body: unknown,
      tenantKey: string,
      builderEmail: string,
    ): Promise<{ readonly ok: true }> {
      const parsed = BuilderLeadStatusBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid status body.',
          false,
        );
      }

      const record = await leadStore.findById(id);
      if (!record) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }

      // Tenant isolation: a builder can only touch their own tenant's leads.
      // This is a 403 (not 404) so the builder knows the lead exists but is
      // out of scope — the same semantics as the admin cross-tenant guard.
      if (record.tenantKey !== tenantKey) {
        await audit.log({
          actorEmail: builderEmail,
          action: 'builder_leads_cross_tenant_denied',
          detail: `leadId=${id} tenantKey=${tenantKey}`,
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This lead belongs to a different builder.',
          false,
        );
      }

      const oldStatus = record.status;
      const newStatus = parsed.data.status;

      if (oldStatus !== newStatus) {
        await leadStore.updateStatus({ id, status: newStatus });
        await leadStore.appendStatusHistory({
          id: randomUUID(),
          leadId: id,
          oldStatus,
          newStatus,
          changedBy: builderEmail,
        });
      }

      await audit.log({
        actorEmail: builderEmail,
        action: 'builder_leads_status_changed',
        detail: `leadId=${id} oldStatus=${oldStatus} newStatus=${newStatus} tenantKey=${tenantKey}`,
      });

      return { ok: true as const };
    },
  };
}
