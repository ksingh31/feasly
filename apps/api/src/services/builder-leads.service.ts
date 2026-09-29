/**
 * Builder leads service (embed/09).
 *
 * Builder-scoped lead pipeline for the builder portal:
 * - `listLeads(tenantKey)` — resolves the builder row for the session's
 *   tenant key, then lists leads assigned to that builder (`builder_id`),
 *   newest first, with a won/lost summary. Quarantined rows are excluded.
 *   A builder sees ONLY their assigned leads.
 * - `updateStatus(id, body, tenantKey, builderEmail)` — pipeline status
 *   transition. The lead MUST be assigned to the builder, otherwise
 *   403 (AC1: cross-builder reads are forbidden). Writes
 *   `lead_status_history` (append-only, for the attribution track) + audit
 *   row with the builder's email.
 *
 * Builder isolation is enforced at the service layer: every read filters by
 * builder_id at the database level, and every write re-verifies the lead's
 * assignment before touching it. Billing still keys on tenant_key (the
 * join key the billing/attribution code uses), resolved from the builder
 * row.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  BuilderLeadInvoiceSummary,
  BuilderLeadListItem,
  BuilderLeadListResponse,
  BuilderLeadStatus,
  CommissionInvoiceStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import type {
  BillableEventResult,
  EmbedBillingHookService,
} from './billing/embed-billing-hook.service';
import type { InvoiceSummaryStore } from './billing/invoice-summary.store';
import type { BuilderService } from './builder.service';
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
  /**
   * Signed construction contract, excl. land — only meaningful with
   * status='won'. When present, the won transition runs the billing
   * charge path (billing/01): attribution → draft commission invoice →
   * auto-submitted into the review window. Without them the won status is
   * recorded and the invoice waits for POST /api/v1/billing/report-contract.
   */
  contractValueCents: z.number().int().positive().optional(),
  contractSignedAt: z.string().datetime({ offset: true }).optional(),
});

export interface BuilderLeadsService {
  /**
   * List the builder's assigned leads with a pipeline summary.
   * Only leads with a matching builder_id are returned.
   */
  listLeads(tenantKey: string): Promise<BuilderLeadListResponse>;
  /**
   * Transition a lead's pipeline status. Throws 404 when the lead doesn't
   * exist, 403 when it isn't assigned to this builder. Writes
   * `lead_status_history` + audit row with the builder's email.
   *
   * When the transition is to 'won', the billing charge path runs first
   * (billing/01): with contract details it creates the draft commission
   * invoice; without them the won status is recorded and the invoice waits
   * for POST /api/v1/billing/report-contract. Billing errors propagate —
   * the status is only updated when the charge path succeeds.
   */
  updateStatus(
    id: string,
    body: unknown,
    tenantKey: string,
    builderEmail: string,
  ): Promise<{ readonly ok: true; readonly billing?: BillableEventResult }>;
}

export interface BuilderLeadsServiceDeps {
  readonly leadStore: LeadStore;
  readonly audit: AdminAuditStore;
  /** Resolves the session tenant key to the builder row (builders table). */
  readonly builders: BuilderService;
  readonly clock?: () => Date;
  /**
   * Billing charge path (billing/01). Invoked when a lead transitions to
   * 'won'. Optional for tests that don't cover billing.
   */
  readonly billingHook?: EmbedBillingHookService;
  /**
   * Per-tenant invoice summaries (record-contract flow redesign). Powers
   * `hasInvoice`/`invoiceSummary` on the lead list items. Optional for
   * tests that don't cover the recorded-contract state.
   */
  readonly invoiceSummaries?: InvoiceSummaryStore;
}

export interface WonBillingResult {
  readonly billing: BillableEventResult;
}

function toListItem(
  record: {
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
  },
  invoiceSummary: BuilderLeadInvoiceSummary | null,
): BuilderLeadListItem {
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
    hasInvoice: invoiceSummary !== null,
    invoiceSummary,
  };
}

export function createBuilderLeadsService(
  deps: BuilderLeadsServiceDeps,
): BuilderLeadsService {
  const { leadStore, audit, builders, billingHook, invoiceSummaries } = deps;

  /**
   * Resolve the session's tenant key to the builder row. Every portal
   * call goes through here so a builder always acts as exactly one
   * builder. Unknown tenant key → 404 (no builder to scope to).
   */
  async function requireBuilder(tenantKey: string) {
    const builder = await builders.getByTenantKey(tenantKey);
    if (builder === null || builder.status !== 'active') {
      throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Builder not found.', false);
    }
    return builder;
  }

  return {
    async listLeads(tenantKey: string): Promise<BuilderLeadListResponse> {
      const builder = await requireBuilder(tenantKey);
      const records = await leadStore.listByBuilderId({
        builderId: builder.id,
      });

      // Recorded-contract lookup: one tenant-scoped query, then a
      // lead→invoice map. Absent in tests that don't cover it.
      const summaries = invoiceSummaries
        ? await invoiceSummaries.findByTenantKey(tenantKey)
        : [];
      const byLeadId = new Map<string, BuilderLeadInvoiceSummary>();
      for (const summary of summaries) {
        if (!byLeadId.has(summary.leadId)) {
          byLeadId.set(summary.leadId, {
            id: summary.id,
            contractValueCents: summary.contractValueCents,
            commissionCents: summary.commissionCents,
            status: summary.status as CommissionInvoiceStatus,
            reviewDueAt: summary.reviewDueAt
              ? summary.reviewDueAt.toISOString()
              : null,
          });
        }
      }

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
        leads: records.map((record) =>
          toListItem(record, byLeadId.get(record.id) ?? null),
        ),
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

      const builder = await requireBuilder(tenantKey);

      // auth/04 (iron rule): tenant scoping happens in SQL from session
      // state. The read AND the write are both scoped by
      // (id, builder_id) — a cross-tenant row is never pulled into the
      // service, never honored, and never silently re-scoped.
      const record = await leadStore.findByIdAndBuilderId({
        id,
        builderId: builder.id,
      });
      if (!record) {
        // Distinguish "exists but isn't yours" (403 + audit) from
        // "doesn't exist" (404) with a boolean probe — no row data.
        const exists = await leadStore.existsById(id);
        if (exists) {
          await audit.log({
            actorEmail: builderEmail,
            action: 'builder_leads_cross_builder_denied',
            detail: `leadId=${id} tenantKey=${tenantKey}`,
          });
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'This lead belongs to a different builder.',
            false,
          );
        }
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
      }

      const oldStatus = record.status;
      const newStatus = parsed.data.status;

      // Contract details are only meaningful on a won transition.
      const { contractValueCents, contractSignedAt } = parsed.data;
      const hasContractDetails =
        contractValueCents !== undefined || contractSignedAt !== undefined;
      if (newStatus !== 'won' && hasContractDetails) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Contract details are only accepted with status "won".',
          false,
        );
      }
      if (hasContractDetails && (contractValueCents === undefined || contractSignedAt === undefined)) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Contract details require both contractValueCents and contractSignedAt.',
          false,
        );
      }

      // Billing runs BEFORE the status update: won + invoice stay atomic.
      // A billing failure leaves the pipeline status untouched so the
      // builder can retry; the hook is idempotent against double-won.
      let billing: BillableEventResult | undefined;
      if (newStatus === 'won' && oldStatus !== 'won' && billingHook !== undefined) {
        billing = await billingHook.recordBillableEvent(
          builder.tenantKey,
          'lead_won',
          {
            leadId: id,
            introducedAt: record.createdAt,
            contractValueCents,
            contractSignedAt:
              contractSignedAt === undefined ? undefined : new Date(contractSignedAt),
          },
        );
      }

      if (oldStatus !== newStatus) {
        // auth/04: the write is tenant-scoped in SQL too — even if the
        // read above were bypassed, this updates zero rows cross-tenant.
        await leadStore.updateStatusForBuilder({
          id,
          builderId: builder.id,
          status: newStatus,
        });
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

      const result: { readonly ok: true; readonly billing?: BillableEventResult } =
        billing === undefined ? { ok: true } : { ok: true, billing };
      return result;
    },
  };
}
