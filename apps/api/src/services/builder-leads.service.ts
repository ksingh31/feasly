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
 * - `getNeedsYou(tenantKey)` — the Leads home "Needs you" groups
 *   (issue #526): uncontacted, stale, won-without-contract, each sorted by
 *   score then age, plus the status counts for the segmented filter.
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
  BuilderLeadNeedsYouItem,
  BuilderLeadsNeedsYouResponse,
  BuilderLeadStatus,
  BuilderLeadStatusCounts,
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
import { SANDBOX_LEAD_NOT_BILLABLE_MESSAGE } from './billing/embed-billing-hook.service';
import type { InvoiceSummaryStore } from './billing/invoice-summary.store';
import type { CommentStore, CommentSummary } from './builder-comments.store';
import type { BuilderService } from './builder.service';
import type { AgreementGate } from './builder-agreement.service';
import type { EmailService } from './email/email.service';
import type { LeadRecord, LeadStatusChangeStore, LeadStore } from './lead.store';
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
   * Leads home "Needs you" feed (issue #526), tenant-scoped like
   * `listLeads`. Groups (a lead lands in at most one):
   * - `uncontacted` — status `new`;
   * - `stale` — `contacted`/`quoted` with no status change for
   *   `staleAfterDays`+ days;
   * - `wonWithoutContract` — `won` with no commission invoice.
   * Each group: score desc, then `waitingSince` asc (oldest first), then id.
   * `counts` covers every scanned lead.
   */
  getNeedsYou(tenantKey: string): Promise<BuilderLeadsNeedsYouResponse>;
  /**
   * Transition a lead's pipeline status. Throws 404 when the lead doesn't
   * exist, 403 when it isn't assigned to this builder, and 409
   * (LEAD_STATUS_LOCKED) when the lead has a recorded signed contract
   * (a commission invoice exists) — recorded leads are status-locked.
   * Writes `lead_status_history` + audit row with the builder's email.
   * The write is a compare-and-set on the status read (#620): a request
   * that loses a race to an identical transition succeeds without a second
   * history row; one that loses to a different transition gets 409
   * (CONFLICT) — except a won transition that already created a commission
   * invoice: the invoice is authoritative, so it re-bases onto the current
   * status and still moves the lead to won.
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

/**
 * #620: how many compare-and-set attempts an invoiced won transition makes
 * before giving up. Each retry re-bases on the freshly read status; once
 * the invoice exists, other transitions are status-locked, so a second
 * attempt practically always lands. Not a tunable — a loop bound.
 */
const INVOICED_WON_CAS_ATTEMPTS = 3;

interface StatusChangeResult {
  readonly ok: true;
  readonly changed: boolean;
  readonly billing?: BillableEventResult;
}

export interface BuilderLeadsServiceDeps {
  readonly leadStore: LeadStore;
  readonly audit: AdminAuditStore;
  /** Resolves the session tenant key to the builder row (builders table). */
  readonly builders: BuilderService;
  /**
   * #722: platform-agreement gate — marking a lead won WITH contract
   * details records the signed contract (the commission charge path), so
   * it needs the org's acceptance of the current agreement (409
   * AGREEMENT_REQUIRED otherwise). Status changes without contract details
   * are not gated.
   */
  readonly agreements: Pick<AgreementGate, 'requireCurrentForTenant'>;
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
  /**
   * Latest status change per lead (lead_status_history) for the "Needs
   * you" staleness rule. Optional for tests that don't cover it — falls
   * back to the row's `updatedAt`.
   */
  readonly statusChanges?: LeadStatusChangeStore;
  /**
   * "Needs you" tunables from config (`lead.needsYouStaleDays`,
   * `lead.needsYouScanLimit`). Required by `getNeedsYou` — it fails with
   * 500 when absent rather than inventing a threshold.
   */
  readonly needsYou?: {
    readonly staleAfterDays: number;
    readonly scanLimit: number;
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function countByStatus(
  records: ReadonlyArray<{ readonly status: string }>,
): BuilderLeadStatusCounts {
  const counts = {
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
        counts.new++;
        break;
      case 'contacted':
        counts.contacted++;
        break;
      case 'quoted':
        counts.quoted++;
        break;
      case 'won':
        counts.won++;
        break;
      case 'lost':
        counts.lost++;
        break;
    }
  }
  return counts;
}

/** Score desc → waitingSince asc (oldest first) → id (stable). */
function compareNeedsYou(
  a: BuilderLeadNeedsYouItem,
  b: BuilderLeadNeedsYouItem,
): number {
  if (a.leadScore !== b.leadScore) {
    return b.leadScore - a.leadScore;
  }
  const byAge = Date.parse(a.waitingSince) - Date.parse(b.waitingSince);
  if (byAge !== 0) {
    return byAge;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
    agreements,
    billingHook,
    invoiceSummaries,
    commentSummaries,
    users,
    memberships,
    email,
    fallbackAdminInbox,
    statusChanges,
    needsYou,
  } = deps;
  const clock = deps.clock ?? (() => new Date());

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

  /** #840: refuse the won/billing path for sandbox (test API key) leads. */
  function requireNonSandbox(record: { readonly sandbox: boolean }): void {
    if (record.sandbox) {
      throw new HttpError(
        409,
        ErrorCodes.CONFLICT,
        SANDBOX_LEAD_NOT_BILLABLE_MESSAGE,
        false,
      );
    }
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
    let lookupFailed = false;
    if (memberships !== undefined) {
      const adminEmails = await memberships
        .listActiveOrgAdminEmails(input.builderId)
        .catch(() => {
          lookupFailed = true;
          return [] as string[];
        });
      orgAdminCount = adminEmails.length;
      for (const adminEmail of adminEmails) {
        const address = adminEmail.trim().toLowerCase();
        if (address && address !== actor) {
          recipients.add(address);
        }
      }
    }
    // A failed lookup is NOT "the org has no admin": don't send the lead's
    // name/address to Feasly ops on a DB blip. Warn (ids only, no PII); the
    // lead still shows as "Needs recording" in the portal and Needs-you feed.
    if (lookupFailed) {
      console.warn(
        `builder-leads: org admin lookup failed for builder ${input.builderId}; skipping ops fallback`,
      );
    }
    // Fallback only when the org has NO active admin — if the actor is the
    // sole admin, they can record it themselves; Feasly ops isn't needed.
    if (!lookupFailed && orgAdminCount === 0 && fallbackAdminInbox) {
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

  /**
   * Shared status-change path for updateStatus and markWon. `changed` is
   * true only when THIS request's compare-and-set write moved the row
   * (#620) — a no-op or a lost race to the same status reports false, so
   * callers with side effects (markWon's admin notice) can skip them.
   */
  async function changeStatus(
    id: string,
    body: unknown,
    tenantKey: string,
    builderEmail: string,
  ): Promise<StatusChangeResult> {
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

    // #840: sandbox leads never enter billing — a won transition would
    // create attribution/commission rows (RESTRICT FKs to leads) that
    // block the sandbox purge. Rejected before any side effect.
    if (newStatus === 'won' && oldStatus !== 'won') {
      requireNonSandbox(record);
    }

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
    // #722: recording a signed contract is a money action — no current
    // agreement acceptance, no contract (before any billing or write).
    if (hasContractDetails) {
      await agreements.requireCurrentForTenant(builder.tenantKey);
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

    // `fromStatus` is the status this request's write actually moved the
    // row from — normally `oldStatus`, but an invoiced won transition that
    // loses the race re-bases onto the current status (below).
    let fromStatus = oldStatus;
    if (oldStatus !== newStatus) {
      // A commission invoice now exists for this lead: the invoice is
      // authoritative, so the lead must end up 'won' even if another
      // request moved it meanwhile — a 409 here would leave an invoice on a
      // non-won lead, status-locked for good by hasRecordedContract.
      const invoiced = billing?.billed === true;
      for (let attempt = 1; ; attempt++) {
        // auth/04: the write is tenant-scoped in SQL too — even if the
        // read above were bypassed, this updates zero rows cross-tenant.
        // #620: it is also a compare-and-set on the status we read, so two
        // concurrent requests from the same read can't both append history.
        const updated = await leadStore.updateStatusForBuilder({
          id,
          builderId: builder.id,
          expectedStatus: fromStatus,
          status: newStatus,
        });
        if (updated !== null) {
          break;
        }
        // Lost the race: another request changed the status between our
        // read and write. If it landed on the status we wanted, this is a
        // duplicate of that transition — succeed without a second history
        // row. Otherwise the builder is acting on a stale view: 409 —
        // unless this request already invoiced, then retry from the
        // current status.
        const current = await leadStore.findByIdAndBuilderId({
          id,
          builderId: builder.id,
        });
        if (current === null) {
          throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Lead not found.', false);
        }
        if (current.status === newStatus) {
          return billing === undefined
            ? { ok: true, changed: false }
            : { ok: true, changed: false, billing };
        }
        if (!invoiced || attempt >= INVOICED_WON_CAS_ATTEMPTS) {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            'This lead was updated by someone else. Refresh and try again.',
            false,
          );
        }
        fromStatus = current.status;
      }
      await leadStore.appendStatusHistory({
        id: randomUUID(),
        leadId: id,
        oldStatus: fromStatus,
        newStatus,
        changedBy: builderEmail,
      });
    }

    await audit.log({
      actorEmail: builderEmail,
      action: 'builder_leads_status_changed',
      detail: `leadId=${id} oldStatus=${fromStatus} newStatus=${newStatus} tenantKey=${tenantKey}`,
    });

    const changed = oldStatus !== newStatus;
    return billing === undefined ? { ok: true, changed } : { ok: true, changed, billing };
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

      const summary = { ...countByStatus(records), needsRecording: 0 };

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

    async getNeedsYou(tenantKey: string): Promise<BuilderLeadsNeedsYouResponse> {
      if (needsYou === undefined) {
        throw new HttpError(
          500,
          ErrorCodes.INTERNAL_ERROR,
          'Needs-you feed is not configured.',
          true,
        );
      }
      const builder = await requireBuilder(tenantKey);
      const records = await leadStore.listByBuilderId({
        builderId: builder.id,
        limit: needsYou.scanLimit,
      });

      // Recorded contracts: one tenant-scoped query. Same rule as the
      // list's `hasInvoice` and the status lock — any invoice counts.
      const recordedLeadIds = new Set<string>();
      if (invoiceSummaries !== undefined && records.some((r) => r.status === 'won')) {
        for (const summary of await invoiceSummaries.findByTenantKey(builder.tenantKey)) {
          recordedLeadIds.add(summary.leadId);
        }
      }

      // Status-change times only matter for the stale and won groups.
      const changeIds = records
        .filter((r) => r.status === 'contacted' || r.status === 'quoted' || r.status === 'won')
        .map((r) => r.id);
      const latestChange: ReadonlyMap<string, Date> | null =
        statusChanges === undefined
          ? null
          : await statusChanges.latestStatusChangeByLeadIds(changeIds);
      const statusChangedAt = (record: LeadRecord): Date =>
        latestChange === null
          ? record.updatedAt
          : latestChange.get(record.id) ?? record.createdAt;

      const staleCutoff = clock().getTime() - needsYou.staleAfterDays * MS_PER_DAY;
      const uncontacted: BuilderLeadNeedsYouItem[] = [];
      const stale: BuilderLeadNeedsYouItem[] = [];
      const wonWithoutContract: BuilderLeadNeedsYouItem[] = [];

      for (const record of records) {
        const changedAt = statusChangedAt(record);
        const item = (waitingSince: Date): BuilderLeadNeedsYouItem => ({
          id: record.id,
          name: record.name,
          email: record.email,
          phone: record.phone,
          timeline: record.timeline,
          leadScore: record.leadScore,
          status: record.status as BuilderLeadStatus,
          addressKey: record.addressKey,
          createdAt: record.createdAt.toISOString(),
          statusChangedAt: changedAt.toISOString(),
          waitingSince: waitingSince.toISOString(),
        });
        switch (record.status) {
          case 'new':
            uncontacted.push(item(record.createdAt));
            break;
          case 'contacted':
          case 'quoted':
            if (changedAt.getTime() <= staleCutoff) {
              stale.push(item(changedAt));
            }
            break;
          case 'won':
            if (!recordedLeadIds.has(record.id)) {
              wonWithoutContract.push(item(changedAt));
            }
            break;
        }
      }

      return {
        uncontacted: uncontacted.sort(compareNeedsYou),
        stale: stale.sort(compareNeedsYou),
        wonWithoutContract: wonWithoutContract.sort(compareNeedsYou),
        staleAfterDays: needsYou.staleAfterDays,
        counts: countByStatus(records),
      };
    },

    async updateStatus(
      id: string,
      body: unknown,
      tenantKey: string,
      builderEmail: string,
    ): Promise<{ readonly ok: true; readonly billing?: BillableEventResult }> {
      const { billing } = await changeStatus(id, body, tenantKey, builderEmail);
      return billing === undefined ? { ok: true } : { ok: true, billing };
    },

    async markWon(
      id: string,
      tenantKey: string,
      actorEmail: string,
    ): Promise<BuilderLeadMarkWonResponse> {
      const builder = await requireBuilder(tenantKey);
      const record = await requireOwnLead(id, builder.id, tenantKey, actorEmail);
      requireNonSandbox(record);

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

      // The won transition itself reuses the updateStatus path WITHOUT contract
      // details: billing parks the win (no invoice), history + audit are
      // written exactly as for any other status change.
      const { changed } = await changeStatus(
        id,
        { status: 'won' },
        tenantKey,
        actorEmail,
      );

      // #620: a concurrent "Mark won" already made (and announced) this
      // transition — no second "Needs recording" notice.
      if (!changed) {
        return {
          ok: true,
          status: 'won',
          needsRecording: true,
          changed: false,
          adminsNotified: 0,
        };
      }

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
