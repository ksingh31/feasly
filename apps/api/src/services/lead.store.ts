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
  /** consumer/02: heuristic score, recomputed on every dedupe update. */
  readonly leadScore: number;
  /** Pipeline status: new | contacted | quoting | won | lost. */
  readonly status: string;
  /** email/03: CASL opt-out timestamp; null = still subscribed. */
  readonly unsubscribedAt: Date | null;
  /** email/02: 24h-nudge exactly-once guard; null = not yet sent. */
  readonly nudgeSentAt: Date | null;
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
  /** Set by the service when the honeypot field arrives filled. */
  readonly quarantined?: boolean;
}

export interface LeadStore {
  /**
   * The most recent lead for this email + property address created at or
   * after `since`, or null. Email must already be normalized by the caller.
   */
  findRecentByEmailAndAddress(args: {
    readonly email: string;
    readonly addressKey: string;
    readonly since: Date;
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
  /** One lead by id, or null. */
  findById(id: string): Promise<LeadRecord | null>;
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
    leadScore: row.leadScore,
    status: row.status,
    unsubscribedAt: row.unsubscribedAt,
    nudgeSentAt: row.nudgeSentAt,
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
          ),
        )
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
          tenantKey: lead.tenantKey ?? null,
          source: lead.source,
          quarantined: lead.quarantined ?? false,
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
    async findById(id: string): Promise<LeadRecord | null> {
      const rows = await db
        .select()
        .from(leads)
        .where(eq(leads.id, id))
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

    async findNudgeCandidates(args): Promise<LeadRecord[]> {
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(
            gte(leads.createdAt, args.createdAfter),
            lt(leads.createdAt, args.createdBefore),
            isNull(leads.nudgeSentAt),
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
  };
}
