/**
 * Admin leads-explorer service (admin/02).
 *
 * Business logic for the admin leads dashboard:
 * - Filtered listing with cursor pagination
 * - Lead detail with estimate summary
 * - Append-only notes
 * - Pipeline status transitions (with history + audit)
 * - CSV export of the filtered set
 *
 * Every cross-tenant read writes an audit row (AC6). Status changes write
 * `lead_status_history` + audit rows with the admin's email (AC4).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AdminLeadDetail,
  AdminLeadListItem,
  AdminLeadListResponse,
  AdminLeadMagicLinkStatus,
  AdminLeadStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import type {
  AdminLeadsStore,
  AdminLeadFilters,
  AdminLeadRow,
} from './admin-leads.store';
import type { EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';

export const AdminLeadStatusSchema = z.enum([
  'new',
  'contacted',
  'quoting',
  'won',
  'lost',
]);

export const AdminLeadSourceSchema = z.enum(['web', 'embed', 'api', 'mcp']);

/** Query params for `GET /api/v1/admin/leads`. */
export const AdminLeadListQuerySchema = z.object({
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  status: AdminLeadStatusSchema.optional(),
  source: AdminLeadSourceSchema.optional(),
  projectType: z.string().trim().min(1).max(50).optional(),
  tenantId: z.string().trim().min(1).max(120).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  includeQuarantined: z.coerce.boolean().optional(),
  includeSandbox: z.coerce.boolean().optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type AdminLeadListQuery = z.infer<typeof AdminLeadListQuerySchema>;

export const AdminLeadNoteBodySchema = z.object({
  note: z.string().trim().min(1).max(5000),
});

export const AdminLeadStatusBodySchema = z.object({
  status: AdminLeadStatusSchema,
});

export interface AdminLeadsService {
  /**
   * List leads with filters + cursor pagination.
   * Writes an audit row (AC6: every cross-tenant read is audited).
   */
  listLeads(
    query: unknown,
    adminEmail: string,
  ): Promise<AdminLeadListResponse>;
  /**
   * Get full lead detail. Writes an audit row (AC6).
   * Throws 404 when the lead doesn't exist.
   */
  getLead(id: string, adminEmail: string): Promise<AdminLeadDetail>;
  /**
   * Append a note (append-only — no edit/delete path exists).
   * Throws 404 when the lead doesn't exist.
   */
  addNote(
    id: string,
    body: unknown,
    adminEmail: string,
  ): Promise<{ readonly ok: true }>;
  /**
   * Transition the pipeline status. Writes `lead_status_history` + audit
   * row with the admin's email (AC4). Throws 404 when the lead doesn't exist.
   */
  updateStatus(
    id: string,
    body: unknown,
    adminEmail: string,
  ): Promise<{ readonly ok: true }>;
  /**
   * Export the filtered set as CSV. Returns the CSV text and filename.
   * Writes an audit row (AC6).
   */
  exportCsv(
    query: unknown,
    adminEmail: string,
  ): Promise<{ readonly csv: string; readonly filename: string }>;
}

export interface AdminLeadsServiceDeps {
  readonly store: AdminLeadsStore;
  readonly leadStore: LeadStore;
  readonly estimateStore: EstimateStore;
  readonly audit: AdminAuditStore;
  /** Max rows for CSV export (from config — prevents runaway exports). */
  readonly maxExportRows: number;
}

function toListItem(row: AdminLeadRow): AdminLeadListItem {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    addressKey: row.addressKey,
    leadScore: row.leadScore,
    status: row.status as AdminLeadStatus,
    source: row.source,
    projectType: row.projectType ?? 'unknown',
    tenantKey: row.tenantKey,
    timeline: row.timeline,
    sandbox: row.sandbox,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Format integer cents as CAD dollars without float math.
 * 123456 cents → "$1,234.56".
 */
export function formatCentsCad(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.trunc(abs / 100);
  const remainder = abs % 100;
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const centsStr = remainder.toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${grouped}.${centsStr}`;
}

function parseQuery(query: unknown): AdminLeadListQuery {
  const parsed = AdminLeadListQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'Invalid list query parameters.',
      false,
    );
  }
  return parsed.data;
}

function toStoreFilters(q: AdminLeadListQuery): AdminLeadFilters {
  return {
    minScore: q.minScore,
    maxScore: q.maxScore,
    status: q.status,
    source: q.source,
    projectType: q.projectType,
    tenantKey: q.tenantId,
    createdAfter: q.createdAfter ? new Date(q.createdAfter) : undefined,
    createdBefore: q.createdBefore ? new Date(q.createdBefore) : undefined,
    search: q.search,
    includeQuarantined: q.includeQuarantined,
    includeSandbox: q.includeSandbox,
  };
}

export function createAdminLeadsService(
  deps: AdminLeadsServiceDeps,
): AdminLeadsService {
  const { store, leadStore, estimateStore, audit, maxExportRows } = deps;

  async function auditRead(
    adminEmail: string,
    action: string,
    detail: string,
  ): Promise<void> {
    await audit.log({
      actorEmail: adminEmail,
      action,
      detail,
    });
  }

  return {
    async listLeads(query, adminEmail): Promise<AdminLeadListResponse> {
      const q = parseQuery(query);
      const result = await store.listLeads({
        filters: toStoreFilters(q),
        cursor: q.cursor ?? null,
        limit: q.limit,
      });

      await auditRead(
        adminEmail,
        'admin_leads_list',
        `filters=${JSON.stringify(toStoreFilters(q))} limit=${q.limit}`,
      );

      return {
        leads: result.rows.map(toListItem),
        nextCursor: result.nextCursor,
        totalCount: result.totalCount,
      };
    },

    async getLead(id, adminEmail): Promise<AdminLeadDetail> {
      const row = await store.findByIdWithEstimate(id);
      if (!row) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }

      await auditRead(adminEmail, 'admin_leads_read', `leadId=${id}`);

      // Estimate summary.
      const estimate = await estimateStore.findById(row.estimateId);
      let estimateSummary: AdminLeadDetail['estimate'] = null;
      if (estimate) {
        const figures = estimate.figures as {
          readonly total?: readonly [number, number];
          readonly build?: readonly [number, number];
          readonly land?: number;
        };
        const inputs = estimate.inputs as {
          readonly sqft?: number;
          readonly tier?: string;
        };
        estimateSummary = {
          estimateId: estimate.id,
          addressKey: estimate.addressKey,
          projectType: estimate.projectType,
          sqft: inputs.sqft ?? null,
          tier: inputs.tier ?? null,
          totalRangeCents: figures.total ?? [0, 0],
          buildRangeCents: figures.build ?? [0, 0],
          landCents: figures.land ?? 0,
          createdAt: estimate.createdAt.toISOString(),
        };
      }

      const magicLinkStatus: AdminLeadMagicLinkStatus =
        await store.getMagicLinkStatus(id);
      const notes = await leadStore.getNotes(id);
      const statusHistory = await leadStore.getStatusHistory(id);

      // Sheets sync timestamp — from the lead's metadata (null when never synced).
      // TODO: wire to the actual Sheets sync worker's tracking table when it lands.
      const sheetsSyncedAt: string | null = null;

      // Snapshot count — from the report snapshots table.
      // TODO: wire to the snapshot store when immutable snapshots land (report/02).
      const snapshotCount = 0;

      return {
        ...toListItem(row),
        phone: row.phone,
        marketingConsent: row.marketingConsent,
        consentTs: row.consentTs.toISOString(),
        quarantined: row.quarantined,
        unsubscribedAt: row.unsubscribedAt?.toISOString() ?? null,
        nudgeSentAt: row.nudgeSentAt?.toISOString() ?? null,
        estimate: estimateSummary,
        magicLinkStatus,
        sheetsSyncedAt,
        snapshotCount,
        notes: notes.map((n, i) => ({
          id: `note-${i}`,
          note: n.note,
          createdAt: n.createdAt.toISOString(),
        })),
        statusHistory: statusHistory.map((h) => ({
          oldStatus: (h.oldStatus as AdminLeadStatus | null) ?? null,
          newStatus: h.newStatus as AdminLeadStatus,
          changedBy: h.changedBy,
          changedAt: h.changedAt.toISOString(),
        })),
      };
    },

    async addNote(id, body, adminEmail): Promise<{ readonly ok: true }> {
      const parsed = AdminLeadNoteBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid note body.',
          false,
        );
      }

      const row = await store.findByIdWithEstimate(id);
      if (!row) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }

      await leadStore.appendNote({
        id: randomUUID(),
        leadId: id,
        note: parsed.data.note,
      });

      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_leads_note_added',
        detail: `leadId=${id}`,
      });

      return { ok: true as const };
    },

    async updateStatus(id, body, adminEmail): Promise<{ readonly ok: true }> {
      const parsed = AdminLeadStatusBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid status body.',
          false,
        );
      }

      const row = await store.findByIdWithEstimate(id);
      if (!row) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }

      const oldStatus = row.status;
      const newStatus = parsed.data.status;

      if (oldStatus !== newStatus) {
        await store.updateStatus({ id, status: newStatus });
        await leadStore.appendStatusHistory({
          id: randomUUID(),
          leadId: id,
          oldStatus,
          newStatus,
          changedBy: adminEmail,
        });
      }

      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_leads_status_changed',
        detail: `leadId=${id} oldStatus=${oldStatus} newStatus=${newStatus}`,
      });

      return { ok: true as const };
    },

    async exportCsv(
      query,
      adminEmail,
    ): Promise<{ readonly csv: string; readonly filename: string }> {
      const q = parseQuery(query);
      // Export uses a large limit but bounded by config.
      const result = await store.listLeads({
        filters: toStoreFilters(q),
        cursor: null,
        limit: maxExportRows,
      });

      await auditRead(
        adminEmail,
        'admin_leads_export',
        `filters=${JSON.stringify(toStoreFilters(q))} rows=${result.rows.length}`,
      );

      // CSV header.
      const headers = [
        'id',
        'name',
        'email',
        'phone',
        'address_key',
        'lead_score',
        'status',
        'source',
        'project_type',
        'tenant_key',
        'timeline',
        'sandbox',
        'quarantined',
        'marketing_consent',
        'consent_ts',
        'created_at',
      ];

      const escapeCsv = (value: string | number | boolean | null): string => {
        if (value === null) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const lines = [headers.join(',')];
      for (const row of result.rows) {
        lines.push(
          [
            escapeCsv(row.id),
            escapeCsv(row.name),
            escapeCsv(row.email),
            escapeCsv(row.phone),
            escapeCsv(row.addressKey),
            escapeCsv(row.leadScore),
            escapeCsv(row.status),
            escapeCsv(row.source),
            escapeCsv(row.projectType ?? ''),
            escapeCsv(row.tenantKey),
            escapeCsv(row.timeline),
            escapeCsv(row.sandbox),
            escapeCsv(row.quarantined),
            escapeCsv(row.marketingConsent),
            escapeCsv(row.consentTs.toISOString()),
            escapeCsv(row.createdAt.toISOString()),
          ].join(','),
        );
      }

      const timestamp = new Date().toISOString().slice(0, 10);
      return {
        csv: lines.join('\n'),
        filename: `feasly-leads-${timestamp}.csv`,
      };
    },
  };
}
