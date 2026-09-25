/**
 * PIPEDA erasure-request + audit persistence (legal/02).
 *
 * The interface is what `PrivacyService` depends on; unit tests fake it.
 * The Drizzle implementation is constructed once in composition.ts.
 *
 * PII discipline: `emailHash` (SHA-256 of the normalized email) is the only
 * identity key here — the raw email is never stored in these tables, so the
 * audit trail stays joinable after erasure deletes the leads rows.
 */
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { erasureRequests, privacyAuditLog } from '../db/schema';

export type ErasureStatus = 'requested' | 'blocked' | 'completed';

export interface ErasureRequestRecord {
  readonly id: string;
  readonly leadId: string | null;
  readonly emailHash: string;
  readonly status: ErasureStatus;
  /** Snapshot of the blockers that stopped a confirm attempt, if any. */
  readonly blockers: unknown;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
}

export type PrivacyAuditAction =
  | 'export'
  | 'export.denied'
  | 'erase.request'
  | 'erase.request.denied'
  | 'erase.confirm'
  | 'erase.confirm.denied'
  | 'erase.blocked'
  /** consumer/06: narrative request denied (bad token or cross-user). */
  | 'narrative.denied';

export interface PrivacyStore {
  /** The newest erasure request for this email hash, or null. */
  findLatestByEmailHash(emailHash: string): Promise<ErasureRequestRecord | null>;
  findById(id: string): Promise<ErasureRequestRecord | null>;
  createRequest(args: {
    readonly leadId: string;
    readonly emailHash: string;
  }): Promise<ErasureRequestRecord>;
  markBlocked(args: {
    readonly id: string;
    readonly blockers: readonly { kind: string; reason: string }[];
  }): Promise<ErasureRequestRecord>;
  markCompleted(id: string, confirmedAt: Date): Promise<ErasureRequestRecord>;
  /** All requests for this email hash, newest first (export history). */
  findAllByEmailHash(emailHash: string): Promise<ErasureRequestRecord[]>;
  /**
   * Append an audit row. `detail` must be PII-free (enforced by review —
   * the type can't prove a negative, so keep details to ids and codes).
   */
  audit(args: {
    readonly leadId: string | null;
    readonly action: PrivacyAuditAction;
    readonly detail?: string;
  }): Promise<void>;
}

export interface DrizzlePrivacyStoreDeps {
  readonly db: AppDb;
}

function toRecord(row: typeof erasureRequests.$inferSelect): ErasureRequestRecord {
  const status = row.status as ErasureStatus;
  return {
    id: row.id,
    leadId: row.leadId,
    emailHash: row.emailHash,
    status,
    blockers: row.blockers,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
  };
}

export function createDrizzlePrivacyStore(
  deps: DrizzlePrivacyStoreDeps,
): PrivacyStore {
  const { db } = deps;
  return {
    async findLatestByEmailHash(emailHash): Promise<ErasureRequestRecord | null> {
      const rows = await db
        .select()
        .from(erasureRequests)
        .where(eq(erasureRequests.emailHash, emailHash))
        .orderBy(desc(erasureRequests.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async findById(id): Promise<ErasureRequestRecord | null> {
      const rows = await db
        .select()
        .from(erasureRequests)
        .where(eq(erasureRequests.id, id))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async createRequest(args): Promise<ErasureRequestRecord> {
      const rows = await db
        .insert(erasureRequests)
        .values({
          id: randomUUID(),
          leadId: args.leadId,
          emailHash: args.emailHash,
          status: 'requested',
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('erasure request insert returned no row');
      return toRecord(row);
    },

    async markBlocked(args): Promise<ErasureRequestRecord> {
      const rows = await db
        .update(erasureRequests)
        .set({ status: 'blocked', blockers: [...args.blockers] })
        .where(eq(erasureRequests.id, args.id))
        .returning();
      const row = rows[0];
      if (!row) throw new Error('erasure request update returned no row');
      return toRecord(row);
    },

    async markCompleted(id, confirmedAt): Promise<ErasureRequestRecord> {
      const rows = await db
        .update(erasureRequests)
        .set({ status: 'completed', confirmedAt })
        .where(eq(erasureRequests.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new Error('erasure request update returned no row');
      return toRecord(row);
    },

    async findAllByEmailHash(emailHash): Promise<ErasureRequestRecord[]> {
      const rows = await db
        .select()
        .from(erasureRequests)
        .where(eq(erasureRequests.emailHash, emailHash))
        .orderBy(desc(erasureRequests.createdAt));
      return rows.map(toRecord);
    },

    async audit(args): Promise<void> {
      await db.insert(privacyAuditLog).values({
        id: randomUUID(),
        leadId: args.leadId,
        action: args.action,
        detail: args.detail ?? null,
      });
    },
  };
}
