/**
 * Lead persistence (BE-3). The interface is what `LeadService` depends on;
 * unit tests fake it. The Drizzle implementation is constructed once in
 * composition.ts.
 *
 * `findRecentByEmailAndAddress` is the 90-day dedup lookup: same normalized
 * email + same property (`address_key` denormalized from the estimate),
 * created within the window. The window bound is a parameter
 * (config-driven), not a constant.
 */
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { estimates, leadNotes, leadStatusHistory, leads } from '../db/schema';

export interface LeadRecord {
  readonly id: string;
  readonly estimateId: string;
  readonly addressKey: string;
  /** Normalized: trimmed + lowercased. */
  readonly email: string;
  readonly name: string;
  readonly phone: string | null;
  readonly timeline: string;
  readonly marketingConsent: boolean;
  readonly consentTs: Date;
  readonly tenantKey: string | null;
  readonly source: string;
  /** HRD-03: honeypot-tripped rows. Excluded from default listings. */
  readonly quarantined: boolean;
  /** api-mcp/01: true when captured via a sandbox API key. */
  readonly sandbox: boolean;
  /** consumer/02: heuristic score, recomputed on every dedupe update. */
  readonly leadScore: number;
  /** Pipeline status: new | contacted | quoting | won | lost. */
  readonly status: string;
  /**
   * Admin-assigned builder (builders table). Null = unassigned; the lead
   * flow never depends on it. The builder portal scopes to this column.
   */
  readonly builderId: string | null;
  /** email/03: CASL opt-out timestamp; null = still subscribed. */
  readonly unsubscribedAt: Date | null;
  /**
   * Contact opt-out (calls/messages from Feasly and builders associated
   * with us); null = gate consent still stands.
   */
  readonly contactOptOutAt: Date | null;
  /** Last change to ANY consent flag (gate capture, opt-out, resubscribe). */
  readonly consentUpdatedAt: Date;
  /** email/02: 24h-nudge exactly-once guard; null = not yet sent. */
  readonly nudgeSentAt: Date | null;
  /** admin/04: Sheets sync watermark; null = never synced. */
  readonly sheetsSyncedAt: Date | null;
  /** admin/04: last modification timestamp (DB trigger-maintained). */
  readonly updatedAt: Date;
  readonly createdAt: Date;
}

export interface NewLead {
  readonly id: string;
  readonly estimateId: string;
  readonly addressKey: string;
  readonly email: string;
  readonly name: string;
  readonly phone?: string;
  readonly timeline: string;
  readonly marketingConsent: boolean;
  readonly consentTs: Date;
  readonly tenantKey?: string;
  readonly source: string;
  /**
   * Embed dual-write (builders table): when the lead carries a tenant key,
   * the service resolves the builder row and stamps its id here in the
   * same insert, so the lead is visible in the builder portal
   * immediately. tenant_key stays populated too (billing/attribution
   * still reads it). Null = unassigned; the lead flow never depends on it.
   */
  readonly builderId?: string | null;
  /** Set by the service when the honeypot field arrives filled. */
  readonly quarantined?: boolean;
  /** Set when captured via a sandbox API key (api-mcp/01). */
  readonly sandbox?: boolean;
}

export interface LeadStore {
  /**
   * The most recent lead for this email + property address created at or
   * after `since`, or null. Email must already be normalized by the caller.
   *
   * SECURITY: the lookup is tenant-scoped — pass the resolved embed tenant
   * key, or `null` for the direct site. The parameter is required so no
   * caller can accidentally run an unscoped lookup: without it, one
   * tenant's repeat submission could rewrite another tenant's lead and
   * mint an owner token for it.
   */
  findRecentByEmailAndAddress(args: {
    readonly email: string;
    readonly addressKey: string;
    readonly since: Date;
    readonly tenantKey: string | null;
  }): Promise<LeadRecord | null>;
  insert(lead: NewLead): Promise<LeadRecord>;
  /**
   * consumer/02 — the 90-day dedupe update. Rewrites ONLY the scalar
   * columns the repeat submission is allowed to refresh (name, phone,
   * timeline, lead_score, estimate_id → newest). Everything else on the
   * row — email, address, consent, consent_ts, status, quarantined,
   * created_at — and the append-only note/status history are never
   * touched. The explicit column list is the guarantee.
   */
  updateOnRepeat(args: {
    readonly id: string;
    readonly name: string;
    readonly phone?: string;
    readonly timeline: string;
    readonly leadScore: number;
    readonly estimateId: string;
    /**
     * Embed dual-write repair: when a repeat submission resolves a tenant
     * whose builder row exists but the stored lead still has a null
     * builder_id (e.g. captured before the builders-table backfill), stamp
     * it now so the lead shows in the builder portal. Undefined = leave
     * the column untouched.
     */
    readonly builderId?: string | null;
  }): Promise<LeadRecord>;
  /**
   * consumer/02 — the newest estimate row for this email + property
   * across ALL of the household's leads (old magic links must resolve to
   * the newest snapshot). Joins through leads so leads older than the
   * dedupe window still resolve forward. Null when the household has no
   * estimates (erasure raced us).
   */
  findNewestEstimateIdByEmailAndAddress(args: {
    readonly email: string;
    readonly addressKey: string;
  }): Promise<{ readonly estimateId: string; readonly createdAt: Date } | null>;
  /**
   * Append one note to the lead's append-only history (consumer/02
   * persistence; the admin/02 HTTP endpoints arrive separately).
   */
  appendNote(args: {
    readonly id: string;
    readonly leadId: string;
    readonly note: string;
  }): Promise<void>;
  /** Every note for a lead, oldest first. */
  getNotes(
    leadId: string,
  ): Promise<ReadonlyArray<{ readonly note: string; readonly createdAt: Date }>>;
  /**
   * Append one status transition to the lead's append-only history
   * (consumer/02 persistence; admin/02 HTTP endpoints arrive separately).
   */
  appendStatusHistory(args: {
    readonly id: string;
    readonly leadId: string;
    readonly oldStatus: string | null;
    readonly newStatus: string;
    readonly changedBy?: string;
  }): Promise<void>;
  /** Every status transition for a lead, oldest first. */
  getStatusHistory(leadId: string): Promise<
    ReadonlyArray<{
      readonly oldStatus: string | null;
      readonly newStatus: string;
      readonly changedBy: string | null;
      readonly changedAt: Date;
    }>
  >;
  /**
   * Default lead listing, newest first. Quarantined rows are EXCLUDED
   * unless `includeQuarantined` is true — the admin `GET /api/v1/admin/leads`
   * default listing, counts, and the Sheets sync worker must all consume
   * this default so spam never leaks into the pipeline; the admin
   * quarantine tab passes `includeQuarantined: true` explicitly.
   */
  listLeads(args?: {
    readonly includeQuarantined?: boolean;
    readonly limit?: number;
  }): Promise<LeadRecord[]>;
  /**
   * embed/09 — tenant-scoped lead listing for the builder portal.
   * Returns only leads with the given tenant_key, newest first.
   * Quarantined rows are EXCLUDED (spam never reaches the builder).
   */
  listByTenantKey(args: {
    readonly tenantKey: string;
    readonly limit?: number;
  }): Promise<LeadRecord[]>;
  /**
   * Returns only leads assigned to the given builder, newest first.
   * Quarantined rows are EXCLUDED (spam never reaches the builder).
   * This is the builder-portal scoping query (builders table migration).
   */
  listByBuilderId(args: {
    readonly builderId: string;
    readonly limit?: number;
  }): Promise<LeadRecord[]>;
  /** One lead by id, or null. */
  findById(id: string): Promise<LeadRecord | null>;
  /**
   * auth/04 — tenant-scoped read: the lead only when it belongs to the
   * given builder. Never returns another builder's row.
   */
  findByIdAndBuilderId(args: {
    readonly id: string;
    readonly builderId: string;
  }): Promise<LeadRecord | null>;
  /**
   * auth/04 — existence probe (boolean only, no row data). Used to tell
   * "cross-tenant" (403 + audit) apart from "not found" (404) without
   * pulling another builder's data.
   */
  existsById(id: string): Promise<boolean>;
  /**
   * embed/09 — update a lead's pipeline status. Used by the builder portal
   * (tenant-scoped at the service layer). Returns the updated record.
   */
  updateStatus(args: {
    readonly id: string;
    readonly status: string;
  }): Promise<LeadRecord | null>;
  /**
   * auth/04 — tenant-scoped write: updates only when the lead belongs to
   * the given builder (`WHERE id = ? AND builder_id = ?`). Returns the
   * updated record, or null when the lead doesn't exist or isn't theirs.
   */
  updateStatusForBuilder(args: {
    readonly id: string;
    readonly builderId: string;
    readonly status: string;
  }): Promise<LeadRecord | null>;
  /**
   * admin/03 — the lead currently pointing at an estimate, or null when the
   * gate hasn't completed. The consumer/02 dedupe rewrites `estimate_id` to
   * the newest estimate, so this is the household's current lead for it.
   */
  findByEstimateId(estimateId: string): Promise<LeadRecord | null>;
  /**
   * email/03 — record a CASL opt-out. Sets `unsubscribed_at` to `at`
   * (idempotent: re-unsubscribing keeps the FIRST timestamp as the audit
   * trail). The consumer dedupe update never touches this column.
   */
  setUnsubscribedAt(args: {
    readonly id: string;
    readonly at: Date;
  }): Promise<LeadRecord | null>;
  /**
   * Granular consent preferences (unsubscribe preference page). Each flag
   * is optional — only provided flags change. Opt-out stamps the timestamp
   * (idempotent: keeps the FIRST opt-out as the audit trail); opting back
   * in clears it to NULL. `consent_updated_at` bumps only when at least one
   * flag actually changed. Returns null when the lead doesn't exist.
   */
  updateConsentPreferences(args: {
    readonly id: string;
    readonly emailOptOut?: boolean;
    readonly contactOptOut?: boolean;
    readonly at: Date;
  }): Promise<LeadRecord | null>;
  /**
   * email/02 — nudge candidates. Leads created in `[createdAfter,
   * createdBefore)` that have never been nudged (`nudge_sent_at IS NULL`).
   * The timer passes a ~1h window anchored at 24h ago; the NULL guard is
   * the exactly-once guarantee, the window just bounds the scan.
   */
  findNudgeCandidates(args: {
    readonly createdAfter: Date;
    readonly createdBefore: Date;
    readonly limit: number;
  }): Promise<LeadRecord[]>;
  /**
   * email/02 — record the 24h nudge. Sets `nudge_sent_at` to `at`
   * (unconditional: the service checks the NULL guard before calling).
   */
  setNudgeSentAt(args: {
    readonly id: string;
    readonly at: Date;
  }): Promise<LeadRecord | null>;
  /**
   * Every lead for this normalized email (the PIPEDA "household" view).
   * Used by the privacy export and erasure flows.
   */
  findAllByEmail(email: string): Promise<LeadRecord[]>;
  /**
   * Delete every lead for this normalized email. Erasure only — there is
   * no other delete path (leads are otherwise append-only).
   * Returns the number of rows deleted.
   */
  deleteByEmail(email: string): Promise<number>;
  /**
   * admin/04 — Sheets sync candidates. Leads where `sheets_synced_at IS NULL`
   * (never synced) OR `updated_at > sheets_synced_at` (modified since last
   * sync). Quarantined rows are EXCLUDED (spam never reaches the Sheet).
   * Ordered by created_at for stable batching.
   */
  findSheetsSyncCandidates(args: {
    readonly limit: number;
  }): Promise<LeadRecord[]>;
  /**
   * admin/04 — record a successful Sheets upsert. Sets `sheets_synced_at`
   * to `at`. The sync worker is the ONLY writer of this column.
   */
  setSheetsSyncedAt(args: {
    readonly id: string;
    readonly at: Date;
  }): Promise<LeadRecord | null>;
  /**
   * admin/05 — count of leads never synced (`sheets_synced_at IS NULL`).
   * Quarantined rows are EXCLUDED (spam never reaches the Sheet), matching
   * the worker's candidate predicate. The ops panel's pending count
   * reconciles exactly with this query.
   */
  countNeverSynced(): Promise<number>;
}

export interface DrizzleLeadStoreDeps {
  readonly db: AppDb;
}

function toRecord(row: typeof leads.$inferSelect): LeadRecord {
  return {
    id: row.id,
    estimateId: row.estimateId,
    addressKey: row.addressKey,
    email: row.email,
    name: row.name,
    phone: row.phone,
    timeline: row.timeline,
    marketingConsent: row.marketingConsent,
    consentTs: row.consentTs,
    tenantKey: row.tenantKey,
    source: row.source,
    quarantined: row.quarantined,
    sandbox: row.sandbox,
    leadScore: row.leadScore,
    status: row.status,
    unsubscribedAt: row.unsubscribedAt,
    contactOptOutAt: row.contactOptOutAt,
    consentUpdatedAt: row.consentUpdatedAt,
    nudgeSentAt: row.nudgeSentAt,
    builderId: row.builderId,
    sheetsSyncedAt: row.sheetsSyncedAt,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

export function createDrizzleLeadStore(deps: DrizzleLeadStoreDeps): LeadStore {
  const { db } = deps;
  return {
    async findRecentByEmailAndAddress(args): Promise<LeadRecord | null> {
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.addressKey, args.addressKey),
            eq(leads.email, args.email),
            gte(leads.createdAt, args.since),
            // Tenant isolation: an embed repeat only matches the same
            // tenant's leads; a direct-site repeat only matches direct
            // (tenant-less) leads. Never match across the boundary.
            args.tenantKey === null
              ? isNull(leads.tenantKey)
              : eq(leads.tenantKey, args.tenantKey),
          ),
        )
        .orderBy(desc(leads.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async insert(lead: NewLead): Promise<LeadRecord> {
      const rows = await db
        .insert(leads)
        .values({
          id: lead.id,
          estimateId: lead.estimateId,
          addressKey: lead.addressKey,
          email: lead.email,
          name: lead.name,
          phone: lead.phone ?? null,
          timeline: lead.timeline,
          marketingConsent: lead.marketingConsent,
          consentTs: lead.consentTs,
          // The gate consent timestamp is the consent-change timestamp for a
          // new lead — set explicitly, never rely on the DB default.
          consentUpdatedAt: lead.consentTs,
          tenantKey: lead.tenantKey ?? null,
          builderId: lead.builderId ?? null,
          source: lead.source,
          quarantined: lead.quarantined ?? false,
          sandbox: lead.sandbox ?? false,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('lead insert returned no row');
      return toRecord(row);
    },

    async listLeads(args): Promise<LeadRecord[]> {
      const conditions = args?.includeQuarantined
        ? []
        : [eq(leads.quarantined, false)];
      const rows = await db
        .select()
        .from(leads)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(leads.createdAt))
        .limit(args?.limit ?? 100);
      return rows.map(toRecord);
    },
    async listByTenantKey(args): Promise<LeadRecord[]> {
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(eq(leads.tenantKey, args.tenantKey), eq(leads.quarantined, false)),
        )
        .orderBy(desc(leads.createdAt))
        .limit(args.limit ?? 100);
      return rows.map(toRecord);
    },
    async listByBuilderId(args): Promise<LeadRecord[]> {
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(eq(leads.builderId, args.builderId), eq(leads.quarantined, false)),
        )
        .orderBy(desc(leads.createdAt))
        .limit(args.limit ?? 100);
      return rows.map(toRecord);
    },
    async updateStatus(args): Promise<LeadRecord | null> {
      const rows = await db
        .update(leads)
        .set({ status: args.status })
        .where(eq(leads.id, args.id))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async updateStatusForBuilder(args): Promise<LeadRecord | null> {
      const rows = await db
        .update(leads)
        .set({ status: args.status })
        .where(and(eq(leads.id, args.id), eq(leads.builderId, args.builderId)))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },
    async findById(id: string): Promise<LeadRecord | null> {
      const rows = await db
        .select()
        .from(leads)
        .where(eq(leads.id, id))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async findByIdAndBuilderId(args): Promise<LeadRecord | null> {
      const rows = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, args.id), eq(leads.builderId, args.builderId)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async existsById(id: string): Promise<boolean> {
      const rows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.id, id))
        .limit(1);
      return rows.length > 0;
    },

    async findByEstimateId(estimateId: string): Promise<LeadRecord | null> {
      const rows = await db
        .select()
        .from(leads)
        .where(eq(leads.estimateId, estimateId))
        .orderBy(desc(leads.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async setUnsubscribedAt(args): Promise<LeadRecord | null> {
      // Idempotent: only stamp when NULL, so the FIRST opt-out stays the
      // audit timestamp even if the link is clicked again later.
      const rows = await db
        .update(leads)
        .set({ unsubscribedAt: sql`COALESCE(${leads.unsubscribedAt}, ${args.at})` })
        .where(eq(leads.id, args.id))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async updateConsentPreferences(args): Promise<LeadRecord | null> {
      const existing = await db
        .select()
        .from(leads)
        .where(eq(leads.id, args.id))
        .limit(1);
      const row = existing[0];
      if (!row) return null;
      const patch: {
        unsubscribedAt?: Date | null;
        contactOptOutAt?: Date | null;
        consentUpdatedAt?: Date;
      } = {};
      if (args.emailOptOut !== undefined) {
        // Idempotent: keep the FIRST opt-out timestamp as the audit trail.
        const next = args.emailOptOut ? (row.unsubscribedAt ?? args.at) : null;
        if ((next?.getTime() ?? null) !== (row.unsubscribedAt?.getTime() ?? null)) {
          patch.unsubscribedAt = next;
        }
      }
      if (args.contactOptOut !== undefined) {
        const next = args.contactOptOut ? (row.contactOptOutAt ?? args.at) : null;
        if ((next?.getTime() ?? null) !== (row.contactOptOutAt?.getTime() ?? null)) {
          patch.contactOptOutAt = next;
        }
      }
      // No flag actually changed: leave consent_updated_at alone so the
      // admin column date keeps meaning "last real change".
      if (Object.keys(patch).length === 0) {
        return toRecord(row);
      }
      patch.consentUpdatedAt = args.at;
      const updated = await db
        .update(leads)
        .set(patch)
        .where(eq(leads.id, args.id))
        .returning();
      const updatedRow = updated[0];
      return updatedRow ? toRecord(updatedRow) : null;
    },

    async findNudgeCandidates(args): Promise<LeadRecord[]> {
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(
            gte(leads.createdAt, args.createdAfter),
            lt(leads.createdAt, args.createdBefore),
            isNull(leads.nudgeSentAt),
            // Proactive outreach respects opt-outs: neither email-unsubscribed
            // nor calls/messages-opted-out leads are nudge candidates.
            isNull(leads.unsubscribedAt),
            isNull(leads.contactOptOutAt),
          ),
        )
        .orderBy(leads.createdAt)
        .limit(args.limit);
      return rows.map(toRecord);
    },

    async setNudgeSentAt(args): Promise<LeadRecord | null> {
      const rows = await db
        .update(leads)
        .set({ nudgeSentAt: args.at })
        .where(eq(leads.id, args.id))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async findAllByEmail(email: string): Promise<LeadRecord[]> {
      const rows = await db
        .select()
        .from(leads)
        .where(eq(leads.email, email));
      return rows.map(toRecord);
    },

    async deleteByEmail(email: string): Promise<number> {
      const rows = await db
        .delete(leads)
        .where(eq(leads.email, email))
        .returning({ id: leads.id });
      return rows.length;
    },

    async updateOnRepeat(args): Promise<LeadRecord> {
      // The explicit .set() column list is the consumer/02 contract: only
      // these scalars may change on a repeat submission.
      const rows = await db
        .update(leads)
        .set({
          name: args.name,
          phone: args.phone ?? null,
          timeline: args.timeline,
          leadScore: args.leadScore,
          estimateId: args.estimateId,
          // Embed dual-write repair (see interface): only stamped when the
          // caller resolved a builder; otherwise the column is untouched.
          ...(args.builderId !== undefined ? { builderId: args.builderId } : {}),
        })
        .where(eq(leads.id, args.id))
        .returning();
      const row = rows[0];
      if (!row) {
        // The service looked the lead up first; reaching here means it was
        // erased between the lookup and the update.
        throw new Error(`lead not found for dedupe update: ${args.id}`);
      }
      return toRecord(row);
    },

    async findNewestEstimateIdByEmailAndAddress(args): Promise<{
      readonly estimateId: string;
      readonly createdAt: Date;
    } | null> {
      const rows = await db
        .select({
          estimateId: estimates.id,
          createdAt: estimates.createdAt,
        })
        .from(leads)
        .innerJoin(estimates, eq(leads.estimateId, estimates.id))
        .where(
          and(
            eq(leads.email, args.email),
            eq(leads.addressKey, args.addressKey),
          ),
        )
        .orderBy(desc(estimates.createdAt))
        .limit(1);
      const row = rows[0];
      return row
        ? { estimateId: row.estimateId, createdAt: row.createdAt }
        : null;
    },

    async appendNote(args): Promise<void> {
      await db.insert(leadNotes).values({
        id: args.id,
        leadId: args.leadId,
        note: args.note,
      });
    },

    async getNotes(leadId: string) {
      const rows = await db
        .select({ note: leadNotes.note, createdAt: leadNotes.createdAt })
        .from(leadNotes)
        .where(eq(leadNotes.leadId, leadId))
        .orderBy(leadNotes.createdAt);
      return rows;
    },

    async appendStatusHistory(args): Promise<void> {
      await db.insert(leadStatusHistory).values({
        id: args.id,
        leadId: args.leadId,
        oldStatus: args.oldStatus,
        newStatus: args.newStatus,
        changedBy: args.changedBy ?? null,
      });
    },

    async getStatusHistory(leadId: string) {
      const rows = await db
        .select({
          oldStatus: leadStatusHistory.oldStatus,
          newStatus: leadStatusHistory.newStatus,
          changedBy: leadStatusHistory.changedBy,
          changedAt: leadStatusHistory.changedAt,
        })
        .from(leadStatusHistory)
        .where(eq(leadStatusHistory.leadId, leadId))
        .orderBy(leadStatusHistory.changedAt);
      return rows;
    },

    async findSheetsSyncCandidates(args): Promise<LeadRecord[]> {
      // admin/04: leads never synced (sheets_synced_at IS NULL) OR modified
      // since their last sync (updated_at > sheets_synced_at). Quarantined
      // rows are excluded — spam never reaches the Sheet.
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.quarantined, false),
            sql`(${leads.sheetsSyncedAt} IS NULL OR ${leads.updatedAt} > ${leads.sheetsSyncedAt})`,
          ),
        )
        .orderBy(leads.createdAt)
        .limit(args.limit);
      return rows.map(toRecord);
    },

    async setSheetsSyncedAt(args): Promise<LeadRecord | null> {
      // The sync worker is the ONLY writer of this column. Note: the
      // updated_at trigger will also fire, which is correct — the sync
      // itself is a modification, but sheets_synced_at is set to `at`
      // (the sync time), so the next run's `updated_at > sheets_synced_at`
      // check will be false unless the lead is modified again.
      const rows = await db
        .update(leads)
        .set({ sheetsSyncedAt: args.at })
        .where(eq(leads.id, args.id))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async countNeverSynced(): Promise<number> {
      // admin/05: the ops panel's pending count. Same predicate the worker
      // uses for candidates, minus the re-sync branch (updated_at >
      // sheets_synced_at) — "pending" = never synced, quarantined excluded.
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .where(
          and(eq(leads.quarantined, false), isNull(leads.sheetsSyncedAt)),
        );
      const n = rows[0]?.n ?? 0;
      return typeof n === 'number' ? n : Number(n);
    },
  };
}
