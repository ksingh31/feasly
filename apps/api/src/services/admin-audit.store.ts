/**
 * Drizzle-backed AdminAuditStore (neighbourhood/05).
 *
 * Append-only audit trail for admin-triggered ops actions (manual
 * community-stats refresh today; future admin stories reuse this store).
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { adminAuditLog } from '../db/schema';

export interface AdminAuditRecord {
  readonly id: string;
  readonly action: string;
  readonly actorEmail: string | null;
  readonly detail: string | null;
  readonly createdAt: Date;
}

export interface AdminAuditStore {
  /**
   * Append one audit entry. `detail` is a short machine-readable summary —
   * never PII, never secrets.
   */
  append(args: {
    readonly action: string;
    readonly actorEmail: string | null;
    readonly detail?: string;
  }): Promise<AdminAuditRecord>;
  /**
   * Fire-and-forget log (for auth flows that don't need the record back).
   */
  log(entry: {
    readonly actorEmail: string | null;
    readonly action: string;
    readonly detail?: string;
  }): Promise<void>;
  /** Most recent entries first (for ops review). */
  recent(limit: number): Promise<readonly AdminAuditRecord[]>;
}

export interface DrizzleAdminAuditStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

function toRecord(row: typeof adminAuditLog.$inferSelect): AdminAuditRecord {
  return {
    id: row.id,
    action: row.action,
    actorEmail: row.actorEmail,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}

export function createDrizzleAdminAuditStore(
  deps: DrizzleAdminAuditStoreDeps,
): AdminAuditStore {
  const { db } = deps;
  return {
    async append(args): Promise<AdminAuditRecord> {
      const rows = await db
        .insert(adminAuditLog)
        .values({
          id: randomUUID(),
          action: args.action,
          actorEmail: args.actorEmail,
          detail: args.detail ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('admin_audit_log insert returned no row');
      return toRecord(row);
    },

    async recent(limit: number): Promise<readonly AdminAuditRecord[]> {
      const rows = await db
        .select()
        .from(adminAuditLog)
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(limit);
      return rows.map(toRecord);
    },

    async log(entry): Promise<void> {
      await db.insert(adminAuditLog).values({
        id: randomUUID(),
        actorEmail: entry.actorEmail,
        action: entry.action,
        detail: entry.detail ?? null,
      });
    },
  };
}

