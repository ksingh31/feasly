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
  AdminLeadMutationResponse,
  AdminLeadStatus,
  CostRange,
  FixedFigure,
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

export const AdminLeadConsentSchema = z.enum(['in', 'out']);

/** Query params for `GET /api/v1/admin/leads`. */
export const AdminLeadListQuerySchema = z.object({
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  status: AdminLeadStatusSchema.optional(),
  source: AdminLeadSourceSchema.optional(),
  projectType: z.string().trim().min(1).max(50).optional(),
  tenantId: z.string().trim().min(1).max(120).optional(),
  /**
   * Builder-assignment filter (admin/08): a builder UUID, or the literal
   * 'unassigned' for leads with no builder assignment. Absent = no
   * assignment filtering.
   */
  builderId: z.union([z.string().uuid(), z.literal('unassigned')]).optional(),
  /** Contact-consent filter. Absent = show every lead (the admin default). */
  consent: AdminLeadConsentSchema.optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  includeQuarantined: z.coerce.boolean().optional(),
  /** Quarantine tab: return only honeypot-flagged rows. */
  quarantinedOnly: z.coerce.boolean().optional(),
  includeSandbox: z.coerce.boolean().optional(),
  includeDiscarded: z.coerce.boolean().optional(),
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
   * Approve a quarantined lead: clears the honeypot/quarantine flag (and
   * any discard flag) so the lead returns to the normal pipeline.
   * Audit-logged. Throws 404 when the lead doesn't exist, 422 when the
   * lead is not quarantined.
   */
  approveQuarantine(
    id: string,
    adminEmail: string,
  ): Promise<AdminLeadMutationResponse>;
  /**
   * Discard a quarantined lead: kept for audit, excluded from every
   * listing and count. Audit-logged. Throws 404 when the lead doesn't
   * exist, 422 when the lead is not quarantined. Idempotent — discarding
   * an already-discarded lead is a no-op success.
   */
  discardQuarantine(
    id: string,
    adminEmail: string,
  ): Promise<AdminLeadMutationResponse>;
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
    quarantined: row.quarantined,
    discarded: row.discarded,
    contactConsent:
      row.unsubscribedAt !== null || row.contactOptOutAt !== null
        ? 'out'
        : 'in',
    consentUpdatedAt: row.consentUpdatedAt.toISOString(),
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

/**
 * Estimate-summary money mapping.
 *
 * Stored estimate figures use the EstimateResponse contract shapes in WHOLE
 * DOLLARS — `{ build: CostRange, total: CostRange, land: FixedFigure }`,
 * where `CostRange = { low, base, high }`. The admin summary reports
 * INTEGER CENTS, so every value is converted (×100 with integer math).
 *
 * Comparison estimates persist `{ rowSets }` instead of ranges — those have
 * no build/total/land and legitimately read as zeros. Anything malformed
 * degrades to zero rather than crashing the detail view. (2026-09-28: the
 * summary previously cast figures to `{ total: [n,n], build: [n,n], land: n }`
 * — a shape the store never persisted — so every lead detail rendered $0.)
 */
function dollarsToCents(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function costRangeToCents(range: unknown): readonly [number, number] {
  if (typeof range !== 'object' || range === null) return [0, 0];
  const { low, high } = range as Partial<CostRange>;
  return [dollarsToCents(low), dollarsToCents(high)];
}

/** Persisted estimate figures (new_build/renovation contract shape). */
interface StoredEstimateFigures {
  readonly total?: CostRange;
  readonly build?: CostRange;
  readonly land?: FixedFigure;
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
    builderId:
      q.builderId === undefined
        ? undefined
        : q.builderId === 'unassigned'
          ? null
          : q.builderId,
    createdAfter: q.createdAfter ? new Date(q.createdAfter) : undefined,
    createdBefore: q.createdBefore ? new Date(q.createdBefore) : undefined,
    search: q.search,
    includeQuarantined: q.includeQuarantined,
    quarantinedOnly: q.quarantinedOnly,
    includeSandbox: q.includeSandbox,
    includeDiscarded: q.includeDiscarded,
    consent: q.consent,
  };
}

/**
 * Load a lead for a quarantine review action.
 * Throws 404 when the lead doesn't exist, 422 when it isn't quarantined.
 */
async function requireQuarantined(
  store: AdminLeadsStore,
  id: string,
): Promise<AdminLeadRow> {
  const row = await store.findByIdWithEstimate(id);
  if (!row) {
    throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
  }
  if (!row.quarantined) {
    throw new HttpError(
      422,
      ErrorCodes.VALIDATION_FAILED,
      'Lead is not quarantined.',
      false,
    );
  }
  return row;
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
        statusCounts: result.statusCounts,
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
        // figures follow the EstimateResponse contract (whole dollars);
        // the summary reports integer cents (see dollarsToCents above).
        const figures = (estimate.figures ?? {}) as StoredEstimateFigures;
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
          totalRangeCents: costRangeToCents(figures.total),
          buildRangeCents: costRangeToCents(figures.build),
          landCents: dollarsToCents(figures.land?.value),
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
        builderId: row.builderId,
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

    async approveQuarantine(
      id,
      adminEmail,
    ): Promise<AdminLeadMutationResponse> {
      const row = await requireQuarantined(store, id);

      // Approve clears both flags — the lead returns to the normal
      // pipeline (and can never be "discarded" while unquarantined).
      await store.updateQuarantine({
        id,
        quarantined: false,
        discarded: false,
      });

      await audit.log({
        actorEmail: adminEmail,
        action: 'admin_leads_quarantine_approved',
        detail: `leadId=${id}`,
      });

      return { ok: true as const };
    },

    async discardQuarantine(
      id,
      adminEmail,
    ): Promise<AdminLeadMutationResponse> {
      const row = await requireQuarantined(store, id);

      // Idempotent: discarding an already-discarded lead is a no-op.
      if (!row.discarded) {
        // `quarantined` stays true so every existing quarantine exclusion
        // (consumer lists, sheets sync, counts) keeps working; `discarded`
        // marks the review outcome and drops the row from the quarantine
        // tab as well.
        await store.updateQuarantine({
          id,
          quarantined: true,
          discarded: true,
        });

        await audit.log({
          actorEmail: adminEmail,
          action: 'admin_leads_quarantine_discarded',
          detail: `leadId=${id}`,
        });
      }

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
        'contact_consent',
        'consent_updated_at',
        'unsubscribed_at',
        'contact_opt_out_at',
        'created_at',
      ];

      // Total CSV escapers: no input value — null, undefined, a wrong-typed
      // date, an Invalid Date — may throw. A single bad row must never kill
      // the entire export (2026-09-27: export failed server-side for the
      // full lead set, likely one bad row; 2026-09-28: hardened further
      // after the null-date fix proved insufficient).
      const escapeCsv = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const lines = [headers.join(',')];
      const isoDate = (d: unknown): string | null => {
        if (d instanceof Date) {
          return Number.isNaN(d.getTime()) ? null : d.toISOString();
        }
        if (typeof d === 'string' || typeof d === 'number') {
          const parsed = new Date(d);
          return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
        }
        return null;
      };
      const serializeRow = (row: AdminLeadRow): string =>
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
          escapeCsv(isoDate(row.consentTs)),
          escapeCsv(
            row.unsubscribedAt !== null || row.contactOptOutAt !== null
              ? 'out'
              : 'in',
          ),
          escapeCsv(isoDate(row.consentUpdatedAt)),
          escapeCsv(isoDate(row.unsubscribedAt)),
          escapeCsv(isoDate(row.contactOptOutAt)),
          escapeCsv(isoDate(row.createdAt)),
        ].join(',');
      for (const row of result.rows) {
        try {
          lines.push(serializeRow(row));
        } catch {
          // Last resort: emit the row id so the export still completes and
          // the bad row is identifiable in the file.
          lines.push(escapeCsv((row as { id?: unknown })?.id ?? ''));
        }
      }

      const timestamp = new Date().toISOString().slice(0, 10);
      return {
        csv: lines.join('\n'),
        filename: `feasly-leads-${timestamp}.csv`,
      };
    },
  };
}
