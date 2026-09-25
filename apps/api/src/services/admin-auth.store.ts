/**
 * Drizzle-backed admin stores (admin/01).
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { adminAllowlist, adminSessions } from '../db/schema';
import type {
  AdminAllowlistStore,
  AdminSessionRecord,
  AdminSessionStore,
} from './admin-auth.service';

export interface DrizzleAdminStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

function toSessionRecord(
  row: typeof adminSessions.$inferSelect,
): AdminSessionRecord {
  return {
    id: row.id,
    email: row.email,
    sessionTokenHash: row.sessionTokenHash,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export function createDrizzleAdminSessionStore(
  deps: DrizzleAdminStoreDeps,
): AdminSessionStore {
  const { db } = deps;
  return {
    async insert(session): Promise<AdminSessionRecord> {
      const rows = await db.insert(adminSessions).values(session).returning();
      const row = rows[0];
      if (!row) throw new Error('admin_sessions insert returned no row');
      return toSessionRecord(row);
    },

    async findActiveByHash(
      sessionTokenHash: string,
      now: Date,
    ): Promise<AdminSessionRecord | null> {
      const rows = await db
        .select()
        .from(adminSessions)
        .where(
          and(
            eq(adminSessions.sessionTokenHash, sessionTokenHash),
            isNull(adminSessions.revokedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const record = toSessionRecord(row);
      // Expiry is checked here (not in SQL) so tests can use a fake clock.
      return record.expiresAt.getTime() > now.getTime() ? record : null;
    },

    async findByHash(
      sessionTokenHash: string,
    ): Promise<AdminSessionRecord | null> {
      const rows = await db
        .select()
        .from(adminSessions)
        .where(
          and(
            eq(adminSessions.sessionTokenHash, sessionTokenHash),
            isNull(adminSessions.revokedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toSessionRecord(row) : null;
    },

    async revokeByHash(
      sessionTokenHash: string,
      revokedAt: Date,
    ): Promise<void> {
      await db
        .update(adminSessions)
        .set({ revokedAt })
        .where(eq(adminSessions.sessionTokenHash, sessionTokenHash));
    },

    async revokeByEmail(email: string, revokedAt: Date): Promise<number> {
      const rows = await db
        .update(adminSessions)
        .set({ revokedAt })
        .where(
          and(
            eq(adminSessions.email, email),
            isNull(adminSessions.revokedAt),
          ),
        )
        .returning({ id: adminSessions.id });
      return rows.length;
    },
  };
}

export function createDrizzleAdminAllowlistStore(
  deps: DrizzleAdminStoreDeps,
): AdminAllowlistStore {
  const { db } = deps;
  return {
    async isAllowlisted(email: string): Promise<boolean> {
      const rows = await db
        .select({ email: adminAllowlist.email })
        .from(adminAllowlist)
        .where(eq(adminAllowlist.email, email))
        .limit(1);
      return rows.length > 0;
    },

    async add(email: string, addedBy: string): Promise<void> {
      await db
        .insert(adminAllowlist)
        .values({ email, addedBy })
        .onConflictDoNothing();
    },

    async remove(email: string): Promise<boolean> {
      const rows = await db
        .delete(adminAllowlist)
        .where(eq(adminAllowlist.email, email))
        .returning({ email: adminAllowlist.email });
      return rows.length > 0;
    },
  };
}
