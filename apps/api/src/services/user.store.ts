/**
 * Drizzle stores for auth/01 (users, invitations, builder memberships).
 * Implements the store interfaces from user.service.ts against Postgres.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  builderMemberships,
  invitations,
  users,
} from '../db/schema';
import type {
  BuilderMembership,
  BuilderRole,
  InvitationRecord,
  InvitationStore,
  MembershipStore,
  StaffRole,
  UserRecord,
  UserStatus,
  UserStore,
} from './user.service';

export interface DrizzleUserStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

type UserRow = typeof users.$inferSelect;
type InvitationRow = typeof invitations.$inferSelect;
type MembershipRow = typeof builderMemberships.$inferSelect;

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    name: row.name,
    status: row.status as UserStatus,
    staffRole: row.staffRole as StaffRole | null,
    isProtected: row.isProtected,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toInvitationRecord(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    email: row.email,
    staffRole: row.staffRole as StaffRole | null,
    builderId: row.builderId,
    builderRole: row.builderRole as BuilderRole | null,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
  };
}

export function createDrizzleUserStore(deps: DrizzleUserStoreDeps): UserStore {
  const { db: database } = deps;
  return {
    async insert(user) {
      const [row] = await database.insert(users).values(user).returning();
      if (!row) throw new Error('user insert returned no row');
      return toUserRecord(row);
    },

    async findByEmail(email: string) {
      const rows = await database
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const row = rows[0];
      return row ? toUserRecord(row) : null;
    },

    async findById(id: string) {
      const rows = await database
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const row = rows[0];
      return row ? toUserRecord(row) : null;
    },

    async setPasswordHash(id: string, passwordHash: string, now: Date) {
      const rows = await database
        .update(users)
        .set({
          passwordHash,
          // invited → active on first password set. Any other status
          // (active, disabled) is preserved — setting a password must
          // never reactivate a deactivated account.
          status: sql`CASE WHEN ${users.status} = 'invited' THEN 'active' ELSE ${users.status} END`,
          updatedAt: now,
        })
        .where(eq(users.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new Error(`user not found: ${id}`);
      return toUserRecord(row);
    },

    async updateUser(id: string, patch, now: Date) {
      const rows = await database
        .update(users)
        .set({ ...patch, updatedAt: now })
        .where(eq(users.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new Error(`user not found: ${id}`);
      return toUserRecord(row);
    },

    async list(limit: number, offset: number) {
      const rows = await database
        .select()
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);
      return rows.map(toUserRecord);
    },
  };
}

export function createDrizzleInvitationStore(
  deps: DrizzleUserStoreDeps,
): InvitationStore {
  const { db: database } = deps;
  return {
    async insert(invitation) {
      const [row] = await database
        .insert(invitations)
        .values(invitation)
        .returning();
      if (!row) throw new Error('invitation insert returned no row');
      return toInvitationRecord(row);
    },

    async findByTokenHash(tokenHash: string) {
      const rows = await database
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      return row ? toInvitationRecord(row) : null;
    },

    async findPendingByEmail(email: string) {
      const rows = await database
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.email, email),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .orderBy(desc(invitations.createdAt));
      return rows.map(toInvitationRecord);
    },

    async markAccepted(id: string, acceptedAt: Date) {
      await database
        .update(invitations)
        .set({ acceptedAt })
        .where(eq(invitations.id, id));
    },

    async revokePendingByEmail(email: string, revokedAt: Date) {
      const rows = await database
        .update(invitations)
        .set({ revokedAt })
        .where(
          and(
            eq(invitations.email, email),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      return rows.length;
    },
  };
}

export function createDrizzleMembershipStore(
  deps: DrizzleUserStoreDeps,
): MembershipStore {
  const { db: database } = deps;
  return {
    async add(userId, builderId, role) {
      const [row] = await database
        .insert(builderMemberships)
        // App-generated UUID (node:crypto) — same discipline as builders.
        .values({ id: randomUUID(), userId, builderId, role })
        .onConflictDoNothing()
        .returning();
      if (row) {
        return {
          builderId: row.builderId,
          role: row.role as BuilderRole,
          createdAt: row.createdAt,
        };
      }
      const existing = await database
        .select()
        .from(builderMemberships)
        .where(
          and(
            eq(builderMemberships.userId, userId),
            eq(builderMemberships.builderId, builderId),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('membership insert returned no row');
      return {
        builderId: found.builderId,
        role: found.role as BuilderRole,
        createdAt: found.createdAt,
      };
    },

    async listByUserId(userId: string) {
      const rows = await database
        .select()
        .from(builderMemberships)
        .where(eq(builderMemberships.userId, userId));
      return rows.map(
        (row: MembershipRow): BuilderMembership => ({
          builderId: row.builderId,
          role: row.role as BuilderRole,
          createdAt: row.createdAt,
        }),
      );
    },

    async remove(userId: string, builderId: string) {
      const rows = await database
        .delete(builderMemberships)
        .where(
          and(
            eq(builderMemberships.userId, userId),
            eq(builderMemberships.builderId, builderId),
          ),
        )
        .returning({ userId: builderMemberships.userId });
      return rows.length > 0;
    },
  };
}
