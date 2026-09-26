/**
 * Partner-share audit persistence (phase-2 wiring).
 *
 * One row per email-to-partner share. The partner's credential is a fresh
 * magic-link row (purpose 'partner-share', lead_id → the owner's lead —
 * never the owner's token); this table records who it went to and whether
 * the email provider accepted the message. The partner email is PII and
 * gets the same handling as lead emails (never logged).
 */
import { desc, eq } from 'drizzle-orm';
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
  };
}
