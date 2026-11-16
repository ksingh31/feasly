/**
 * Link-only report share persistence (#838).
 *
 * A link share is a `partner_shares` row with kind 'link' and no
 * recipient, pointing at a fresh partner-share magic link (random token,
 * only the hash stored). Expiry and revocation live on the magic-link row
 * — revoking a share stamps `magic_links.revoked_at`, which every token
 * check (`isMagicLinkLive`) already honors, so a revoked link stops
 * opening the report immediately.
 *
 * Kept out of `PartnerShareStore` so existing fakes stay unchanged.
 */
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { magicLinks, partnerShares } from '../db/schema';

export interface ShareLinkRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface ShareLinkStore {
  /** Record a link share for an already-issued partner-share magic link. */
  insert(args: { readonly id: string; readonly leadId: string; readonly magicLinkId: string }): Promise<void>;
  /** A lead's link shares, newest first (capped). */
  listByLeadId(leadId: string, limit: number): Promise<readonly ShareLinkRecord[]>;
  /** Live (not revoked, not expired) link shares for a lead. */
  countActive(leadId: string, now: Date): Promise<number>;
  /**
   * Revoke one of the lead's link shares. Returns the share (with the
   * revocation time) or null when no such link share belongs to the lead.
   * Idempotent: an already-revoked link keeps its first revocation time.
   */
  revoke(args: { readonly shareId: string; readonly leadId: string; readonly now: Date }): Promise<ShareLinkRecord | null>;
}

export function createDrizzleShareLinkStore(deps: { readonly db: AppDb }): ShareLinkStore {
  const { db } = deps;

  async function find(shareId: string, leadId: string): Promise<{ record: ShareLinkRecord; magicLinkId: string } | null> {
    const rows = await db
      .select({
        id: partnerShares.id,
        createdAt: partnerShares.createdAt,
        magicLinkId: magicLinks.id,
        expiresAt: magicLinks.expiresAt,
        revokedAt: magicLinks.revokedAt,
      })
      .from(partnerShares)
      .innerJoin(magicLinks, eq(magicLinks.id, partnerShares.magicLinkId))
      .where(
        and(
          eq(partnerShares.id, shareId),
          eq(partnerShares.leadId, leadId),
          eq(partnerShares.kind, 'link'),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      magicLinkId: row.magicLinkId,
      record: {
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      },
    };
  }

  return {
    async insert(args) {
      await db.insert(partnerShares).values({
        id: args.id,
        leadId: args.leadId,
        magicLinkId: args.magicLinkId,
        partnerEmail: null,
        kind: 'link',
        // Nothing to deliver — the owner copies the link themselves.
        sent: false,
      });
    },

    async listByLeadId(leadId, limit) {
      const rows = await db
        .select({
          id: partnerShares.id,
          createdAt: partnerShares.createdAt,
          expiresAt: magicLinks.expiresAt,
          revokedAt: magicLinks.revokedAt,
        })
        .from(partnerShares)
        .innerJoin(magicLinks, eq(magicLinks.id, partnerShares.magicLinkId))
        .where(and(eq(partnerShares.leadId, leadId), eq(partnerShares.kind, 'link')))
        .orderBy(desc(partnerShares.createdAt))
        .limit(limit);
      return rows;
    },

    async countActive(leadId, now) {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(partnerShares)
        .innerJoin(magicLinks, eq(magicLinks.id, partnerShares.magicLinkId))
        .where(
          and(
            eq(partnerShares.leadId, leadId),
            eq(partnerShares.kind, 'link'),
            isNull(magicLinks.revokedAt),
            gt(magicLinks.expiresAt, now),
          ),
        );
      return Number(rows[0]?.n ?? 0);
    },

    async revoke(args) {
      const found = await find(args.shareId, args.leadId);
      if (!found) return null;
      if (found.record.revokedAt === null) {
        await db
          .update(magicLinks)
          .set({ revokedAt: args.now })
          .where(and(eq(magicLinks.id, found.magicLinkId), isNull(magicLinks.revokedAt)));
      }
      const after = await find(args.shareId, args.leadId);
      return after?.record ?? null;
    },
  };
}
