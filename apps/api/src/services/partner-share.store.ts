/**
 * Partner-share audit persistence (phase-2 wiring).
 *
 * One row per email-to-partner share. The partner's credential is a fresh
 * magic-link row (purpose 'partner-share', lead_id → the owner's lead —
 * never the owner's token); this table records who it went to and whether
 * the email provider accepted the message. The partner email is PII and
 * gets the same handling as lead emails (never logged).
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { partnerShares } from '../db/schema';

export interface PartnerShareRecord {
  readonly id: string;
  readonly leadId: string;
  readonly magicLinkId: string | null;
  readonly partnerEmail: string;
  readonly sent: boolean;
  readonly createdAt: Date;
}

export interface NewPartnerShare {
  readonly id: string;
  readonly leadId: string;
  readonly magicLinkId: string | null;
  readonly partnerEmail: string;
  readonly sent: boolean;
}

export interface PartnerShareStore {
  insert(share: NewPartnerShare): Promise<PartnerShareRecord>;
  /** Latest shares for a lead, newest first (admin views). */
  listByLeadId(leadId: string): Promise<readonly PartnerShareRecord[]>;
  /**
   * Number of shares for a lead created at/after `since` — abuse-control
   * counting for the CAP-008 per-day share cap. DB-side count; rows are
   * never materialized.
   */
  countSince(leadId: string, since: Date): Promise<number>;
  /**
   * The audit row for the magic-link row that was emailed. Only links the
   * share service actually emailed (insert happens after the provider
   * accepts) are redeemable — a minted-but-never-sent link is invalid.
   */
  findByMagicLinkId(magicLinkId: string): Promise<PartnerShareRecord | null>;
}

type ShareRow = typeof partnerShares.$inferSelect;

function toRecord(row: ShareRow): PartnerShareRecord {
  return {
    id: row.id,
    leadId: row.leadId,
    magicLinkId: row.magicLinkId,
    partnerEmail: row.partnerEmail,
    sent: row.sent,
    createdAt: row.createdAt,
  };
}

export interface DrizzlePartnerShareStoreDeps {
  readonly db: AppDb;
}

export function createDrizzlePartnerShareStore(
  deps: DrizzlePartnerShareStoreDeps,
): PartnerShareStore {
  const { db } = deps;
  return {
    async insert(share: NewPartnerShare): Promise<PartnerShareRecord> {
      const rows = await db
        .insert(partnerShares)
        .values({
          id: share.id,
          leadId: share.leadId,
          magicLinkId: share.magicLinkId,
          partnerEmail: share.partnerEmail,
          sent: share.sent,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('partner share insert returned no row');
      return toRecord(row);
    },

    async listByLeadId(leadId: string): Promise<readonly PartnerShareRecord[]> {
      const rows = await db
        .select()
        .from(partnerShares)
        .where(eq(partnerShares.leadId, leadId))
        .orderBy(desc(partnerShares.createdAt));
      return rows.map(toRecord);
    },

    async countSince(leadId: string, since: Date): Promise<number> {
      const rows = await db
        .select({ id: partnerShares.id })
        .from(partnerShares)
        .where(
          and(
            eq(partnerShares.leadId, leadId),
            gte(partnerShares.createdAt, since),
          ),
        );
      return rows.length;
    },

    async findByMagicLinkId(
      magicLinkId: string,
    ): Promise<PartnerShareRecord | null> {
      const rows = await db
        .select()
        .from(partnerShares)
        .where(eq(partnerShares.magicLinkId, magicLinkId))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },
  };
}
