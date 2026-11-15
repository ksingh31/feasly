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
 * - `markWon(id, tenantKey, actorEmail)` — issue #530: any org member may
 *   mark a lead won (no contract details, so no invoice). The lead then
 *   carries `needsRecording` and every active org admin is emailed to
 *   record the signed contract (falls back to the Feasly ops inbox when
 *   the org has no admin). Recording stays `builder:billing`-only.
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
  BuilderLeadCommentPreview,
  BuilderLeadInvoiceSummary,
  BuilderLeadListItem,
  BuilderLeadListResponse,
  BuilderLeadMarkWonResponse,
  BuilderLeadStatus,
  BuilderPaymentMethod,
  CommentAuthorKind,
  CommissionInvoiceStatus,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import type {
  BillableEventResult,
  EmbedBillingHookService,
} from './billing/embed-billing-hook.service';
import type { InvoiceSummaryStore } from './billing/invoice-summary.store';
import type { CommentStore, CommentSummary } from './builder-comments.store';
import type { BuilderService } from './builder.service';
import type { EmailService } from './email/email.service';
import type { LeadStore } from './lead.store';
import type { MembershipStore, UserStore } from './user.service';

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
   * exist, 403 when it isn't assigned to this builder, and 409
   * (LEAD_STATUS_LOCKED) when the lead has a recorded signed contract
   * (a commission invoice exists) — recorded leads are status-locked.
   * Writes `lead_status_history` + audit row with the builder's email.
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
  /**
   * Issue #530: mark a lead won WITHOUT recording the contract (member-
   * allowed). Same 404/403 scoping as updateStatus; 409
   * LEAD_STATUS_LOCKED when a contract is already recorded. Already-won
   * leads return `changed: false` and are not re-notified. On a real
   * transition every active org admin (except the actor) is emailed a
   * "Needs recording" notice — best-effort: an email failure never fails
   * the request (the lead list's `needsRecording` flag is the durable
   * item).
   */
  markWon(
    id: string,
    tenantKey: string,
    actorEmail: string,
  ): Promise<BuilderLeadMarkWonResponse>;
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
  /**
   * Per-entity comment summaries (notes section redesign). Powers
   * `commentCount`/`latestComment` on the lead list items — one query
   * for all leads, builder-visible rows only. Optional for tests that
   * don't cover comments.
   */
  readonly commentSummaries?: Pick<CommentStore, 'summariesByEntity'>;
  /**
   * Resolves comment author ids to display names for the preview.
   * Optional for tests that don't cover comments (falls back to
   * 'Unknown', matching the comments service).
   */
  readonly users?: Pick<UserStore, 'findById'>;
  /**
   * Issue #530: org-admin lookup for the "Needs recording" notice.
   * Optional for tests that don't cover notifications.
   */
  readonly memberships?: Pick<MembershipStore, 'listActiveOrgAdminEmails'>;
  /** Issue #530: sends the "Needs recording" notice. Optional in tests. */
  readonly email?: Pick<EmailService, 'sendContractNeedsRecording'>;
  /**
   * Issue #530: where the notice goes when the org has no active admin
   * (config OPS_ALERT_EMAIL) — Feasly staff can record it from the admin
   * console. Omitted = no fallback.
   */
  readonly fallbackAdminInbox?: string;
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
  comment: {
    readonly count: number;
    readonly latest: BuilderLeadCommentPreview | null;
  } | null,
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
    commentCount: comment?.count ?? 0,
    latestComment: comment?.latest ?? null,
    needsRecording: record.status === 'won' && invoiceSummary === null,
  };
}

export function createBuilderLeadsService(
  deps: BuilderLeadsServiceDeps,
): BuilderLeadsService {
  const {
    leadStore,
    audit,
    builders,
    billingHook,
    invoiceSummaries,
    commentSummaries,
    users,
    memberships,
    email,
    fallbackAdminInbox,
  } = deps;

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

  /**
   * auth/04 (iron rule): the read is scoped by (id, builder_id) in SQL. A
   * cross-tenant row is never pulled into the service. Distinguishes
   * "exists but isn't yours" (403 + audit) from "doesn't exist" (404)
   * with a boolean probe — no row data.
   */
  async function requireOwnLead(
    id: string,
    builderId: string,
    tenantKey: string,
    actorEmail: string,
  ) {
    const record = await leadStore.findByIdAndBuilderId({ id, builderId });
    if (record) {
      return record;
    }
    const exists = await leadStore.existsById(id);
    if (exists) {
      await audit.log({
        actorEmail,
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

  async function hasRecordedContract(
    leadId: string,
    builderTenantKey: string,
  ): Promise<boolean> {
    return (
      invoiceSummaries !== undefined &&
      (await invoiceSummaries.hasInvoiceForLead({
        leadId,
        tenantKey: builderTenantKey,
      }))
    );
  }

  /**
   * Issue #530: email every active org admin (except the actor) that a
   * lead needs its contract recorded. Falls back to the Feasly ops inbox
   * when the org has no active admin at all. Best-effort — never throws; returns
   * how many emails were accepted.
   */
  async function notifyAdminsNeedsRecording(input: {
    readonly builderId: string;
    readonly builderName: string;
    readonly actorEmail: string;
    readonly lead: {
      readonly id: string;
      readonly name: string;
      readonly addressKey: string;
    };
  }): Promise<number> {
    if (email === undefined) {
      return 0;
    }
    const actor = input.actorEmail.trim().toLowerCase();
    const recipients = new Set<string>();
    let orgAdminCount = 0;
    if (memberships !== undefined) {
      const adminEmails = await memberships
        .listActiveOrgAdminEmails(input.builderId)
        .catch(() => [] as string[]);
      orgAdminCount = adminEmails.length;
      for (const adminEmail of adminEmails) {
        const address = adminEmail.trim().toLowerCase();
        if (address && address !== actor) {
          recipients.add(address);
        }
      }
    }
    // Fallback only when the org has NO active admin — if the actor is the
    // sole admin, they can record it themselves; Feasly ops isn't needed.
    if (orgAdminCount === 0 && fallbackAdminInbox) {
      recipients.add(fallbackAdminInbox);
    }

    let sent = 0;
    for (const to of recipients) {
      const delivery = await email
        .sendContractNeedsRecording({
          to,
          markedBy: input.actorEmail,
          leadName: input.lead.name,
          address: input.lead.addressKey,
          builderName: input.builderName,
          leadId: input.lead.id,
        })
        .catch(() => null);
      if (delivery?.sent) {
        sent++;
      }
    }
    return sent;
  }

  const service: BuilderLeadsService = {
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
            invoiceNumber: summary.invoiceNumber,
            contractValueCents: summary.contractValueCents,
            commissionCents: summary.commissionCents,
            status: summary.status as CommissionInvoiceStatus,
            reviewDueAt: summary.reviewDueAt
              ? summary.reviewDueAt.toISOString()
              : null,
            paymentMethod: summary.paymentMethod as BuilderPaymentMethod,
          });
        }
      }

      // Notes lookup: one entity-scoped query for every listed lead, then
      // a lead→comment-summary map. Builder-visible rows only
      // (includeAdminOnly=false — the store enforces it in SQL).
      const commentRows: ReadonlyMap<string, CommentSummary> = commentSummaries
        ? await commentSummaries.summariesByEntity({
            entityType: 'lead',
            entityIds: records.map((record) => record.id),
            includeAdminOnly: false,
          })
        : new Map();

      // The user store has no batch read — dedupe author ids, one
      // lookup each. 'Unknown' matches the comments service fallback.
      const authorNames = new Map<string, string>();
      if (users !== undefined) {
        const authorIds = new Set<string>();
        for (const row of commentRows.values()) {
          if (row.latest !== null) {
            authorIds.add(row.latest.authorId);
          }
        }
        await Promise.all(
          [...authorIds].map(async (authorId) => {
            const user = await users.findById(authorId).catch(() => null);
            const name = user?.name?.trim();
            authorNames.set(authorId, name ? name : 'Unknown');
          }),
        );
      }
      const commentPreviewFor = (
        leadId: string,
      ): {
        readonly count: number;
        readonly latest: BuilderLeadCommentPreview | null;
      } | null => {
        const row = commentRows.get(leadId);
        if (!row) {
          return null;
        }
        return {
          count: row.count,
          latest:
            row.latest === null
              ? null
              : {
                  body: row.latest.body,
                  authorDisplayName:
                    authorNames.get(row.latest.authorId) ?? 'Unknown',
                  authorKind: row.latest.authorKind as CommentAuthorKind,
                  createdAt: row.latest.createdAt.toISOString(),
                },
        };
      };

      const summary = {
        total: records.length,
        new: 0,
        contacted: 0,
        quoted: 0,
        won: 0,
        lost: 0,
        needsRecording: 0,
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

      const leads = records.map((record) =>
        toListItem(
          record,
          byLeadId.get(record.id) ?? null,
          commentPreviewFor(record.id),
        ),
      );
      summary.needsRecording = leads.filter((lead) => lead.needsRecording).length;

      return { leads, summary };
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
      const record = await requireOwnLead(id, builder.id, tenantKey, builderEmail);

      const oldStatus = record.status;
      const newStatus = parsed.data.status;

      // Lead status lock (2026-09-29, Karan): once a signed contract is
      // recorded (a commission invoice exists), the pipeline status is
      // frozen — a won/recorded lead can never be flipped back. Rejected
      // before any billing or write side effects.
      if (
        newStatus !== oldStatus &&
        (await hasRecordedContract(id, builder.tenantKey))
      ) {
        throw new HttpError(
          409,
          ErrorCodes.LEAD_STATUS_LOCKED,
          'Status is locked: a signed contract is already recorded for this lead.',
          false,
        );
      }

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

    async markWon(
      id: string,
      tenantKey: string,
      actorEmail: string,
    ): Promise<BuilderLeadMarkWonResponse> {
      const builder = await requireBuilder(tenantKey);
      const record = await requireOwnLead(id, builder.id, tenantKey, actorEmail);

      // A recorded lead is already closed out — nothing to mark.
      if (await hasRecordedContract(id, builder.tenantKey)) {
        throw new HttpError(
          409,
          ErrorCodes.LEAD_STATUS_LOCKED,
          'Status is locked: a signed contract is already recorded for this lead.',
          false,
        );
      }

      // Idempotent: already won (and still unrecorded) — no write, no
      // re-notify. The lead list keeps showing it as "Needs recording".
      if (record.status === 'won') {
        return {
          ok: true,
          status: 'won',
          needsRecording: true,
          changed: false,
          adminsNotified: 0,
        };
      }

      // The won transition itself reuses updateStatus WITHOUT contract
      // details: billing parks the win (no invoice), history + audit are
      // written exactly as for any other status change.
      await service.updateStatus(id, { status: 'won' }, tenantKey, actorEmail);

      const adminsNotified = await notifyAdminsNeedsRecording({
        builderId: builder.id,
        builderName: builder.displayName,
        actorEmail,
        lead: { id: record.id, name: record.name, addressKey: record.addressKey },
      });

      await audit.log({
        actorEmail,
        action: 'builder_leads_marked_won',
        detail: `leadId=${id} tenantKey=${tenantKey} adminsNotified=${adminsNotified}`,
      });

      return {
        ok: true,
        status: 'won',
        needsRecording: true,
        changed: true,
        adminsNotified,
      };
    },
  };
  return service;
}
