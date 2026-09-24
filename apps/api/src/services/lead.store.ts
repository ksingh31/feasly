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
import { and, desc, eq, gte } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { leads } from '../db/schema';

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
  };
}
