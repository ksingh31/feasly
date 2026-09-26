/**
 * Embed relay-code persistence (embed/06).
 *
 * The interface is what `EmbedRelayService` depends on; unit tests fake it.
 * The Drizzle implementation is constructed once in composition.ts.
 *
 * Security model: only the SHA-256 hex of the opaque code is stored.
 * Hashing lives HERE (the single place codes become hashes) so no caller
 * can accidentally persist — or compare — a raw code. Raw codes exist only
 * in the `issue` return value, destined for the magic-link email.
 *
 * Single-use is enforced atomically: `exchange` does
 * `UPDATE ... SET used_at = now() WHERE id = ? AND used_at IS NULL` and
 * checks the affected row count. Concurrent double-exchanges → exactly one
 * success; the loser sees the row as already used.
 *
 * Audit: every exchange attempt (success AND failure) writes an
 * `embed_relay_audit_log` row with `codeId`, `tenantKey`, `ipHash` and a
 * machine-readable result. No raw codes, no raw IPs, no PII — ever.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { embedRelayAuditLog, embedRelayCodes } from '../db/schema';

export interface EmbedRelayCodeRecord {
  readonly id: string;
  /** SHA-256 hex — never the raw code. */
  readonly codeHash: string;
  readonly tenantKey: string;
  readonly userId: string | null;
  readonly estimateId: string | null;
  readonly leadId: string | null;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly createdAt: Date;
}

/** What `issue` hands back: the row id plus the ONE-TIME raw code. */
export interface IssuedEmbedRelayCode {
  readonly id: string;
  /** Opaque bearer code — the only time it exists outside the email. */
  readonly code: string;
  readonly expiresAt: Date;
}

export interface IssueEmbedRelayCodeArgs {
  readonly tenantKey: string;
  readonly userId?: string;
  readonly estimateId?: string;
  readonly leadId?: string;
  /** Seconds from now until expiry — from config, never hardcoded. */
  readonly ttlSeconds: number;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

export interface ExchangeEmbedRelayCodeArgs {
  /** The raw code as presented by the iframe. */
  readonly code: string;
  /** SHA-256 hex of the client IP — audit without PII. */
  readonly ipHash: string;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

/** Outcome of an atomic exchange attempt. */
export type EmbedRelayExchangeResult =
  | { readonly ok: true; readonly record: EmbedRelayCodeRecord }
  | { readonly ok: false; readonly reason: 'not_found' | 'expired' | 'used' };

export interface EmbedRelayStore {
  /**
   * Mint a code for a tenant. Returns the raw code exactly once — the
   * caller is responsible for delivering it (magic-link email) and must
   * never persist it.
   */
  issue(args: IssueEmbedRelayCodeArgs): Promise<IssuedEmbedRelayCode>;
  /**
   * Atomically consume a code. The UPDATE marks `used_at` only when it is
   * still NULL — concurrent double-exchanges yield exactly one success.
   * The caller decides the HTTP semantics from `reason` so denial reasons
   * stay uniform (no oracle for code enumeration beyond the 410 contract).
   */
  exchange(args: ExchangeEmbedRelayCodeArgs): Promise<EmbedRelayExchangeResult>;
  /** Append an audit row. Never throws — audit must not break the request. */
  audit(args: {
    readonly codeId: string | null;
    readonly tenantKey: string;
    readonly ipHash: string;
    readonly action: 'issued' | 'exchanged' | 'exchange.denied';
    readonly detail?: string;
  }): Promise<void>;
}

/** SHA-256 hex — the only form in which codes are stored or compared. */
export function hashRelayCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** SHA-256 hex of a client IP — audit without PII. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip, 'utf8').digest('hex');
}

/** 32-byte random code, hex-encoded (64 chars). */
export function generateRelayCode(): string {
  return randomBytes(32).toString('hex');
}

export interface DrizzleEmbedRelayStoreDeps {
  readonly db: AppDb;
}

function toRecord(row: typeof embedRelayCodes.$inferSelect): EmbedRelayCodeRecord {
  return {
    id: row.id,
    codeHash: row.codeHash,
    tenantKey: row.tenantKey,
    userId: row.userId,
    estimateId: row.estimateId,
    leadId: row.leadId,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    createdAt: row.createdAt,
  };
}

export function createDrizzleEmbedRelayStore(
  deps: DrizzleEmbedRelayStoreDeps,
): EmbedRelayStore {
  const { db } = deps;
  return {
    async issue(args): Promise<IssuedEmbedRelayCode> {
      const clock = args.clock ?? (() => new Date());
      const code = generateRelayCode();
      const now = clock();
      const rows = await db
        .insert(embedRelayCodes)
        .values({
          id: randomUUID(),
          codeHash: hashRelayCode(code),
          tenantKey: args.tenantKey,
          userId: args.userId ?? null,
          estimateId: args.estimateId ?? null,
          leadId: args.leadId ?? null,
          expiresAt: new Date(now.getTime() + args.ttlSeconds * 1000),
        })
        .returning({ id: embedRelayCodes.id, expiresAt: embedRelayCodes.expiresAt });
      const row = rows[0];
      if (!row) throw new Error('embed relay code insert returned no row');
      return { id: row.id, code, expiresAt: row.expiresAt };
    },

    async exchange(args): Promise<EmbedRelayExchangeResult> {
      const clock = args.clock ?? (() => new Date());
      const now = clock();
      const codeHash = hashRelayCode(args.code);

      // Look up the row by hash. The caller maps "not found" to the uniform
      // 410 — no oracle for code enumeration.
      const rows = await db
        .select()
        .from(embedRelayCodes)
        .where(eq(embedRelayCodes.codeHash, codeHash))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired' };
      }

      // Atomic single-use: only the first UPDATE with used_at IS NULL wins.
      // Drizzle's .returning() gives us the affected rows — zero means the
      // code was already consumed by a concurrent exchange.
      const updated = await db
        .update(embedRelayCodes)
        .set({ usedAt: now })
        .where(and(eq(embedRelayCodes.id, row.id), isNull(embedRelayCodes.usedAt)))
        .returning({ id: embedRelayCodes.id });
      if (updated.length === 0) {
        return { ok: false, reason: 'used' };
      }
      return { ok: true, record: toRecord({ ...row, usedAt: now }) };
    },

    async audit(args): Promise<void> {
      try {
        await db.insert(embedRelayAuditLog).values({
          id: randomUUID(),
          codeId: args.codeId,
          tenantKey: args.tenantKey,
          ipHash: args.ipHash,
          action: args.action,
          detail: args.detail ?? null,
        });
      } catch {
        // Audit must never break the request path.
      }
    },
  };
}
