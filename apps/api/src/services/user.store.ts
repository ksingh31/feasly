/**
 * Drizzle stores for auth/01 (users, invitations, builder memberships).
 * Implements the store interfaces from user.service.ts against Postgres.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
  InvitationStatus,
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
    name: row.name,
    status: row.status as UserStatus,
    staffRole: row.staffRole as StaffRole | null,
    entraObjectId: row.entraObjectId,
    isProtected: row.isProtected,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toInvitationRecord(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    email: row.email,
    invitedBy: row.invitedBy,
    role: row.role as StaffRole | BuilderRole,
    builderId: row.builderId,
    entraUserId: row.entraUserId,
    status: row.status as InvitationStatus,
    expiresAt: row.expiresAt,
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

    async list(
      limit: number,
      offset: number,
      filter?: { builderIds?: readonly string[] },
    ) {
      // auth/03: builder admins only see users in the orgs they administer.
      const orgFilter =
        filter?.builderIds?.length
          ? inArray(
              users.id,
              database
                .select({ userId: builderMemberships.userId })
                .from(builderMemberships)
                .where(
                  inArray(builderMemberships.builderId, [...filter.builderIds]),
                ),
            )
          : undefined;
      const rows = await database
        .select()
        .from(users)
        .where(orgFilter)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);
      return rows.map(toUserRecord);
    },

    async count(filter?: { builderIds?: readonly string[] }) {
      const orgFilter =
        filter?.builderIds?.length
          ? inArray(
              users.id,
              database
                .select({ userId: builderMemberships.userId })
                .from(builderMemberships)
                .where(
                  inArray(builderMemberships.builderId, [...filter.builderIds]),
                ),
            )
          : undefined;
      const rows = await database
        .select({ value: sql<number>`count(*)` })
        .from(users)
        .where(orgFilter);
      return Number(rows[0]?.value ?? 0);
    },

    async delete(id: string) {
      const rows = await database
        .delete(users)
        .where(eq(users.id, id))
        .returning({ id: users.id });
      return rows.length > 0;
    },

    async countActiveByStaffRole(role: StaffRole) {
      const rows = await database
        .select({ value: sql<number>`count(*)` })
        .from(users)
        .where(
          and(eq(users.staffRole, role), eq(users.status, 'active')),
        );
      return Number(rows[0]?.value ?? 0);
    },

    async listActiveStaffAdminIds() {
      // auth/07: no count(*) here — Postgres forbids FOR UPDATE with
      // aggregates. Select the ids (deterministic id order so two
      // concurrent guards never deadlock) and let the caller count.
      const rows = await database
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(users.staffRole, ['super_admin', 'admin']),
            eq(users.status, 'active'),
          ),
        )
        .orderBy(users.id)
        .for('update');
      return rows.map((r: { id: string }) => r.id);
    },

    async transact(fn) {
      // auth/07: transaction-scoped stores built from the tx handle, so
      // the guard's FOR UPDATE locks and the guarded mutation share one
      // connection and commit atomically.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return database.transaction(async (tx: any) => {
        const txUsers = createDrizzleUserStore({ db: tx });
        const txMemberships = createDrizzleMembershipStore({ db: tx });
        return fn({ users: txUsers, memberships: txMemberships });
      });
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

    async findPendingByEmail(email: string) {
      const rows = await database
        .select()
        .from(invitations)
        .where(
          and(eq(invitations.email, email), eq(invitations.status, 'pending')),
        )
        .orderBy(desc(invitations.createdAt));
      return rows.map(toInvitationRecord);
    },

    async findLatestByEmail(email: string) {
      const rows = await database
        .select()
        .from(invitations)
        .where(eq(invitations.email, email))
        .orderBy(desc(invitations.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? toInvitationRecord(row) : null;
    },

    async markStatus(id: string, status: InvitationStatus) {
      const rows = await database
        .update(invitations)
        .set({ status })
        .where(eq(invitations.id, id))
        .returning();
      if (!rows[0]) throw new Error(`invitation not found: ${id}`);
    },

    async revokePendingByEmail(email: string) {
      const rows = await database
        .update(invitations)
        .set({ status: 'revoked' })
        .where(
          and(eq(invitations.email, email), eq(invitations.status, 'pending')),
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

    async listActiveOrgAdminIds(builderId: string) {
      // auth/07: same discipline as listActiveStaffAdminIds — select
      // ids only (no count(*) with FOR UPDATE), deterministic id order.
      // Locks the membership rows AND the joined user rows; the caller
      // excludes the mutation target itself.
      const rows = await database
        .select({ id: users.id })
        .from(builderMemberships)
        .innerJoin(users, eq(builderMemberships.userId, users.id))
        .where(
          and(
            eq(builderMemberships.builderId, builderId),
            eq(builderMemberships.role, 'builder_admin'),
            eq(users.status, 'active'),
          ),
        )
        .orderBy(users.id)
        .for('update');
      return rows.map((r: { id: string }) => r.id);
    },
  };
}
