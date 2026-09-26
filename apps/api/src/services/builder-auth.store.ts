/**
 * Drizzle-backed builder stores (embed/09).
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { builderAllowlist, builderSessions } from '../db/schema';
import type {
  BuilderAllowlistStore,
  BuilderSessionRecord,
  BuilderSessionStore,
} from './builder-auth.service';

export interface DrizzleBuilderStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

function toSessionRecord(
  row: typeof builderSessions.$inferSelect,
): BuilderSessionRecord {
  return {
    id: row.id,
    email: row.email,
    tenantKey: row.tenantKey,
    sessionTokenHash: row.sessionTokenHash,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export function createDrizzleBuilderSessionStore(
  deps: DrizzleBuilderStoreDeps,
): BuilderSessionStore {
  const { db } = deps;
  return {
    async insert(session): Promise<BuilderSessionRecord> {
      const rows = await db.insert(builderSessions).values(session).returning();
      const row = rows[0];
      if (!row) throw new Error('builder_sessions insert returned no row');
      return toSessionRecord(row);
    },

    async findActiveByHash(
      sessionTokenHash: string,
      now: Date,
    ): Promise<BuilderSessionRecord | null> {
      const rows = await db
        .select()
        .from(builderSessions)
        .where(
          and(
            eq(builderSessions.sessionTokenHash, sessionTokenHash),
            isNull(builderSessions.revokedAt),
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
    ): Promise<BuilderSessionRecord | null> {
      const rows = await db
        .select()
        .from(builderSessions)
        .where(
          and(
            eq(builderSessions.sessionTokenHash, sessionTokenHash),
            isNull(builderSessions.revokedAt),
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
        .update(builderSessions)
        .set({ revokedAt })
        .where(eq(builderSessions.sessionTokenHash, sessionTokenHash));
    },

    async revokeByEmail(email: string, revokedAt: Date): Promise<number> {
      const rows = await db
        .update(builderSessions)
        .set({ revokedAt })
        .where(
          and(eq(builderSessions.email, email), isNull(builderSessions.revokedAt)),
        )
        .returning({ id: builderSessions.id });
      return rows.length;
    },
  };
}

export function createDrizzleBuilderAllowlistStore(
  deps: DrizzleBuilderStoreDeps,
): BuilderAllowlistStore {
  const { db } = deps;
  return {
    async isAllowlisted(email: string): Promise<boolean> {
      const rows = await db
        .select({ email: builderAllowlist.email })
        .from(builderAllowlist)
        .where(eq(builderAllowlist.email, email))
        .limit(1);
      return rows.length > 0;
    },

    async getTenantKey(email: string): Promise<string | null> {
      const rows = await db
        .select({ tenantKey: builderAllowlist.tenantKey })
        .from(builderAllowlist)
        .where(eq(builderAllowlist.email, email))
        .limit(1);
      const row = rows[0];
      return row ? row.tenantKey : null;
    },

    async add(email: string, tenantKey: string, addedBy: string): Promise<void> {
      await db
        .insert(builderAllowlist)
        .values({ email, tenantKey, addedBy })
        .onConflictDoNothing();
    },

    async remove(email: string): Promise<boolean> {
      const rows = await db
        .delete(builderAllowlist)
        .where(eq(builderAllowlist.email, email))
        .returning({ email: builderAllowlist.email });
      return rows.length > 0;
    },
  };
}
