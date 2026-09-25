/**
 * Magic-link token persistence (legal/02).
 *
 * The interface is what `LeadService` (issuance) and `PrivacyService`
 * (bearer verification) depend on; unit tests fake it. The Drizzle
 * implementation is constructed once in composition.ts.
 *
 * Security model: only the SHA-256 hex of the opaque token is stored.
 * Hashing lives HERE (the single place tokens become hashes) so no caller
 * can accidentally persist — or compare — a raw token. Raw tokens exist only
 * in the `issue` return value, destined for the magic-link email (BE-5).
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { magicLinks } from '../db/schema';

export interface MagicLinkRecord {
  readonly id: string;
  readonly leadId: string | null;
  readonly purpose: string;
  /** SHA-256 hex — never the raw token. */
  readonly tokenHash: string;
  /** Admin auth (admin/01): the email this link was issued for, else null. */
  readonly email: string | null;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/** What `issue` hands back: the row id plus the ONE-TIME raw token. */
export interface IssuedMagicLink {
  readonly id: string;
  /** Opaque bearer token — the only time it exists outside the email. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface IssueMagicLinkArgs {
  /**
   * The lead this link is for. Null for non-lead purposes (e.g. admin
   * auth) — the `purpose` distinguishes the flow.
   */
  readonly leadId: string | null;
  readonly purpose?: string;
  /**
   * Admin auth (admin/01): the allowlisted email this link is issued for.
   * Null for lead flows.
   */
  readonly email?: string | null;
  /** Seconds from now until expiry — from config, never hardcoded. */
  readonly ttlSeconds: number;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

export interface MagicLinkStore {
  /**
   * Mint a token for a lead. Returns the raw token exactly once — the
   * caller is responsible for delivering it (magic-link email) and must
   * never persist it.
   */
  issue(args: IssueMagicLinkArgs): Promise<IssuedMagicLink>;
  /**
   * Resolve a bearer token to its row. Returns null for unknown tokens;
   * the CALLER decides validity (expired / revoked) so denial reasons stay
   * uniform (no oracle for token enumeration).
   */
  findByToken(token: string): Promise<MagicLinkRecord | null>;
  /** All link rows for a set of leads (export + erasure revocation). */
  findByLeadIds(leadIds: readonly string[]): Promise<MagicLinkRecord[]>;
  /** Mark every link for these leads revoked (erasure). Returns the count. */
  revokeByLeadIds(leadIds: readonly string[], revokedAt: Date): Promise<number>;
  /**
   * Mark a link consumed (single-use). Sets `usedAt`; returns false if the
   * link was already used (replay attempt).
   */
  markUsed(id: string, usedAt: Date): Promise<boolean>;
}

/** SHA-256 hex — the only form in which tokens are stored or compared. */
export function hashMagicToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface DrizzleMagicLinkStoreDeps {
  readonly db: AppDb;
}

function toRecord(row: typeof magicLinks.$inferSelect): MagicLinkRecord {
  return {
    id: row.id,
    leadId: row.leadId,
    purpose: row.purpose,
    email: row.email,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export function createDrizzleMagicLinkStore(
  deps: DrizzleMagicLinkStoreDeps,
): MagicLinkStore {
  const { db } = deps;
  return {
    async issue(args): Promise<IssuedMagicLink> {
      const clock = args.clock ?? (() => new Date());
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const now = clock();
      const rows = await db
        .insert(magicLinks)
        .values({
          id: randomUUID(),
          leadId: args.leadId,
          purpose: args.purpose ?? 'lead',
          email: args.email ?? null,
          tokenHash: hashMagicToken(token),
          expiresAt: new Date(now.getTime() + args.ttlSeconds * 1000),
        })
        .returning({ id: magicLinks.id, expiresAt: magicLinks.expiresAt });
      const row = rows[0];
      if (!row) throw new Error('magic link insert returned no row');
      return { id: row.id, token, expiresAt: row.expiresAt };
    },

    async findByToken(token: string): Promise<MagicLinkRecord | null> {
      const rows = await db
        .select()
        .from(magicLinks)
        .where(eq(magicLinks.tokenHash, hashMagicToken(token)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async findByLeadIds(leadIds: readonly string[]): Promise<MagicLinkRecord[]> {
      if (leadIds.length === 0) return [];
      const rows = await db
        .select()
        .from(magicLinks)
        .where(inArray(magicLinks.leadId, [...leadIds]));
      return rows.map(toRecord);
    },

    async revokeByLeadIds(
      leadIds: readonly string[],
      revokedAt: Date,
    ): Promise<number> {
      if (leadIds.length === 0) return 0;
      const rows = await db
        .update(magicLinks)
        .set({ revokedAt })
        .where(
          and(
            inArray(magicLinks.leadId, [...leadIds]),
            isNull(magicLinks.revokedAt),
          ),
        )
        .returning({ id: magicLinks.id });
      return rows.length;
    },

    async markUsed(id: string, usedAt: Date): Promise<boolean> {
      const rows = await db
        .update(magicLinks)
        .set({ usedAt })
        .where(and(eq(magicLinks.id, id), isNull(magicLinks.usedAt)))
        .returning({ id: magicLinks.id });
      return rows.length > 0;
    },
  };
}
