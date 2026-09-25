/**
 * Admin leads-explorer persistence (admin/02).
 *
 * Filtered listing with cursor pagination, detail queries with estimate
 * joins, and status updates. The interface is what `AdminLeadsService`
 * depends on; unit tests fake it. The Drizzle implementation is constructed
 * once in composition.ts.
 *
 * Cursor pagination: `(created_at, id)` — stable under concurrent inserts
 * because new rows sort after the cursor position. The cursor is an opaque
 * base64-encoded JSON `{ createdAt, id }`.
 */
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { estimates, leads, magicLinks } from '../db/schema';

export interface AdminLeadFilters {
  readonly minScore?: number;
  readonly maxScore?: number;
  readonly status?: string;
  readonly source?: string;
  readonly projectType?: string;
  readonly tenantKey?: string;
  readonly createdAfter?: Date;
  readonly createdBefore?: Date;
  readonly search?: string;
  readonly includeQuarantined?: boolean;
  readonly includeSandbox?: boolean;
}

export interface AdminLeadListArgs {
  readonly filters: AdminLeadFilters;
  /** Opaque cursor from the previous page; null for the first page. */
  readonly cursor?: string | null;
  readonly limit: number;
}

export interface AdminLeadRow {
  readonly id: string;
  readonly estimateId: string;
  readonly addressKey: string;
  readonly email: string;
  readonly name: string;
  readonly phone: string | null;
  readonly timeline: string;
  readonly marketingConsent: boolean;
  readonly consentTs: Date;
  readonly tenantKey: string | null;
  readonly source: string;
  readonly quarantined: boolean;
  readonly sandbox: boolean;
  readonly leadScore: number;
  readonly status: string;
  readonly unsubscribedAt: Date | null;
  readonly nudgeSentAt: Date | null;
  readonly createdAt: Date;
  /** Project type from the joined estimate (null when estimate missing). */
  readonly projectType: string | null;
}

export interface AdminLeadListResult {
  readonly rows: AdminLeadRow[];
  /** Opaque cursor for the next page; null when this is the last page. */
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface AdminLeadsStore {
  /**
   * Filtered, paginated lead listing. All filters combine with AND.
   * Excludes quarantined and sandbox rows unless explicitly included.
   */
  listLeads(args: AdminLeadListArgs): Promise<AdminLeadListResult>;
  /** One lead by id with its estimate's project type, or null. */
  findByIdWithEstimate(id: string): Promise<AdminLeadRow | null>;
  /**
   * Update the lead's pipeline status. Returns the updated row, or null
   * when the lead doesn't exist.
   */
  updateStatus(args: {
    readonly id: string;
    readonly status: string;
  }): Promise<AdminLeadRow | null>;
  /**
   * Magic-link status for a lead: 'sent' (live link exists), 'used'
   * (link was consumed), 'expired' (all links expired), 'none' (no links).
   */
  getMagicLinkStatus(leadId: string): Promise<'sent' | 'used' | 'expired' | 'none'>;
}

export interface DrizzleAdminLeadsStoreDeps {
  readonly db: AppDb;
}

interface CursorPayload {
  readonly createdAt: string;
  readonly id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  const payload: CursorPayload = {
    createdAt: createdAt.toISOString(),
    id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (
      typeof parsed.createdAt === 'string' &&
      typeof parsed.id === 'string' &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

function buildFilterConditions(filters: AdminLeadFilters) {
  const conditions = [];

  if (filters.minScore !== undefined) {
    conditions.push(gte(leads.leadScore, filters.minScore));
  }
  if (filters.maxScore !== undefined) {
    conditions.push(lte(leads.leadScore, filters.maxScore));
  }
  if (filters.status) {
    conditions.push(eq(leads.status, filters.status));
  }
  if (filters.source) {
    conditions.push(eq(leads.source, filters.source));
  }
  if (filters.projectType) {
    conditions.push(eq(estimates.projectType, filters.projectType));
  }
  if (filters.tenantKey) {
    conditions.push(eq(leads.tenantKey, filters.tenantKey));
  }
  if (filters.createdAfter) {
    conditions.push(gte(leads.createdAt, filters.createdAfter));
  }
  if (filters.createdBefore) {
    conditions.push(lte(leads.createdAt, filters.createdBefore));
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(leads.name, pattern),
        ilike(leads.email, pattern),
        ilike(leads.addressKey, pattern),
      ),
    );
  }
  if (!filters.includeQuarantined) {
    conditions.push(eq(leads.quarantined, false));
  }
  if (!filters.includeSandbox) {
    conditions.push(eq(leads.sandbox, false));
  }

  return conditions;
}

function toRow(
  lead: typeof leads.$inferSelect,
  projectType: string | null,
): AdminLeadRow {
  return {
    id: lead.id,
    estimateId: lead.estimateId,
    addressKey: lead.addressKey,
    email: lead.email,
    name: lead.name,
    phone: lead.phone,
    timeline: lead.timeline,
    marketingConsent: lead.marketingConsent,
    consentTs: lead.consentTs,
    tenantKey: lead.tenantKey,
    source: lead.source,
    quarantined: lead.quarantined,
    sandbox: lead.sandbox,
    leadScore: lead.leadScore,
    status: lead.status,
    unsubscribedAt: lead.unsubscribedAt,
    nudgeSentAt: lead.nudgeSentAt,
    createdAt: lead.createdAt,
    projectType,
  };
}

export function createDrizzleAdminLeadsStore(
  deps: DrizzleAdminLeadsStoreDeps,
): AdminLeadsStore {
  const { db } = deps;

  return {
    async listLeads(args): Promise<AdminLeadListResult> {
      const { filters, limit } = args;
      const conditions = buildFilterConditions(filters);

      // Cursor: (created_at, id) — fetch one extra to detect next page.
      const cursor = args.cursor ? decodeCursor(args.cursor) : null;
      if (cursor) {
        const cursorDate = new Date(cursor.createdAt);
        conditions.push(
          or(
            sql`${leads.createdAt} < ${cursorDate}`,
            and(
              eq(leads.createdAt, cursorDate),
              sql`${leads.id} < ${cursor.id}`,
            ),
          ),
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Count query (for totalCount).
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(leads)
        .leftJoin(estimates, eq(leads.estimateId, estimates.id))
        .where(where);
      const totalCount = countRows[0]?.count ?? 0;

      // Page query: newest first, id as tiebreaker.
      const rows = await db
        .select({
          lead: leads,
          projectType: estimates.projectType,
        })
        .from(leads)
        .leftJoin(estimates, eq(leads.estimateId, estimates.id))
        .where(where)
        .orderBy(desc(leads.createdAt), desc(leads.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const result: AdminLeadRow[] = pageRows.map((r) =>
        toRow(r.lead, r.projectType),
      );

      let nextCursor: string | null = null;
      if (hasMore && result.length > 0) {
        const last = result[result.length - 1];
        nextCursor = encodeCursor(last.createdAt, last.id);
      }

      return { rows: result, nextCursor, totalCount };
    },

    async findByIdWithEstimate(id): Promise<AdminLeadRow | null> {
      const rows = await db
        .select({
          lead: leads,
          projectType: estimates.projectType,
        })
        .from(leads)
        .leftJoin(estimates, eq(leads.estimateId, estimates.id))
        .where(eq(leads.id, id))
        .limit(1);

      const row = rows[0];
      if (!row) return null;
      return toRow(row.lead, row.projectType);
    },

    async updateStatus(args): Promise<AdminLeadRow | null> {
      const rows = await db
        .update(leads)
        .set({ status: args.status })
        .where(eq(leads.id, args.id))
        .returning();

      const lead = rows[0];
      if (!lead) return null;

      // Fetch project type for the response.
      const estRows = await db
        .select({ projectType: estimates.projectType })
        .from(estimates)
        .where(eq(estimates.id, lead.estimateId))
        .limit(1);

      return toRow(lead, estRows[0]?.projectType ?? null);
    },

    async getMagicLinkStatus(
      leadId: string,
    ): Promise<'sent' | 'used' | 'expired' | 'none'> {
      const rows = await db
        .select({
          usedAt: magicLinks.usedAt,
          expiresAt: magicLinks.expiresAt,
        })
        .from(magicLinks)
        .where(eq(magicLinks.leadId, leadId))
        .orderBy(desc(magicLinks.createdAt));

      if (rows.length === 0) return 'none';

      const now = new Date();
      let hasLive = false;
      let hasUsed = false;

      for (const row of rows) {
        if (row.usedAt) {
          hasUsed = true;
        } else if (row.expiresAt > now) {
          hasLive = true;
        }
      }

      if (hasLive) return 'sent';
      if (hasUsed) return 'used';
      return 'expired';
    },
  };
}
