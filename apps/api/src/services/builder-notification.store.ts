/**
 * Builder notification persistence (#725).
 *
 * - `builder_notification_preferences`: per (user, org) email preferences.
 *   A member without a row gets the defaults (new-lead on, digest off,
 *   billing on — owner decision 2026-11-15); the defaults are applied here,
 *   in one place.
 * - `builder_notifications`: send-once outbox. `enqueue` inserts with
 *   ON CONFLICT (dedupe_key) DO NOTHING, so a repeated event never creates a
 *   second row. `claim` is a conditional UPDATE (status pending, no live
 *   lease) so the in-request send and the retry timer can never both send
 *   the same row.
 *
 * Only services and composition.ts import from src/db/.
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { BuilderNotificationPreferences } from '@feasly/contracts';
import type { AppDb } from '../db/client';
import {
  builderMemberships,
  builderNotificationPreferences,
  builderNotifications,
  builders,
  estimates,
  leads,
  users,
} from '../db/schema';

export type BuilderNotificationKind = 'new_lead' | 'needs_you_digest';
export type BuilderNotificationStatus = 'pending' | 'sent' | 'skipped' | 'failed';
export type BuilderMemberRole = 'builder_admin' | 'builder_member';

/** Owner decision 2026-11-15: new-lead on, digest off, billing on. */
export const DEFAULT_BUILDER_NOTIFICATION_PREFERENCES: BuilderNotificationPreferences =
  Object.freeze({ newLeadEmail: true, needsYouDigest: false, billingEmail: true });

/** An active (users.status = 'active') member of a builder org. */
export interface NotificationMember {
  readonly userId: string;
  readonly email: string;
  readonly role: BuilderMemberRole;
  readonly preferences: BuilderNotificationPreferences;
}

export interface NotificationBuilder {
  readonly id: string;
  readonly tenantKey: string;
  readonly displayName: string;
  /** 'active' | 'inactive'. */
  readonly status: string;
}

/** What the new-lead email needs about a lead (no contact details). */
export interface NotificationLead {
  readonly id: string;
  readonly name: string;
  readonly builderId: string | null;
  readonly quarantined: boolean;
  readonly discarded: boolean;
  readonly sandbox: boolean;
  readonly addressKey: string;
  /** From the lead's estimate: 'new_build' | 'renovation' | …. */
  readonly projectType: string;
}

export interface NewBuilderNotification {
  readonly id: string;
  readonly dedupeKey: string;
  readonly kind: BuilderNotificationKind;
  readonly builderId: string;
  readonly userId: string;
  readonly leadId: string | null;
}

export interface BuilderNotificationRecord extends NewBuilderNotification {
  readonly status: BuilderNotificationStatus;
  readonly attempts: number;
  readonly createdAt: Date;
}

export interface BuilderNotificationStore {
  findBuilder(builderId: string): Promise<NotificationBuilder | null>;
  findBuilderByTenantKey(tenantKey: string): Promise<NotificationBuilder | null>;
  /** Active members of the org with their (defaulted) preferences. */
  listActiveMembers(builderId: string): Promise<readonly NotificationMember[]>;
  /** One active member by sign-in email (lowercased) or user id. */
  findActiveMember(
    builderId: string,
    who: { readonly email: string } | { readonly userId: string },
  ): Promise<NotificationMember | null>;
  /** Upsert the member's full preference row. */
  savePreferences(args: {
    readonly userId: string;
    readonly builderId: string;
    readonly preferences: BuilderNotificationPreferences;
    readonly at: Date;
  }): Promise<void>;
  /** Active builders with at least one active member opted into the digest. */
  listDigestBuilders(): Promise<readonly NotificationBuilder[]>;
  findLead(leadId: string): Promise<NotificationLead | null>;
  /** Insert outbox rows; rows whose dedupe_key exists are skipped. */
  enqueue(rows: readonly NewBuilderNotification[]): Promise<void>;
  /**
   * Pending rows eligible for a delivery attempt: created at/after
   * `createdAfter`, fewer than `maxAttempts` attempts, and no live claim
   * (last attempt before `leaseCutoff`). Optional lead filter.
   */
  listPending(args: {
    readonly createdAfter: Date;
    readonly leaseCutoff: Date;
    readonly maxAttempts: number;
    readonly limit: number;
    readonly leadId?: string;
    readonly dedupeKeys?: readonly string[];
  }): Promise<readonly BuilderNotificationRecord[]>;
  /**
   * Claim one row for a delivery attempt (attempts + 1, lease starts).
   * False when another worker holds a live claim or the row is done.
   */
  claim(args: {
    readonly id: string;
    readonly now: Date;
    readonly leaseCutoff: Date;
  }): Promise<boolean>;
  /** Close a row (sent / skipped / failed). */
  finish(args: {
    readonly id: string;
    readonly status: Exclude<BuilderNotificationStatus, 'pending'>;
    readonly at: Date;
    readonly errorCode?: string | null;
  }): Promise<void>;
  /** Keep a row pending for a retry, recording the failure code. */
  recordFailure(args: { readonly id: string; readonly errorCode: string }): Promise<void>;
}

type PrefsRow = {
  newLeadEmail: boolean | null;
  needsYouDigest: boolean | null;
  billingEmail: boolean | null;
};

function withDefaults(row: PrefsRow): BuilderNotificationPreferences {
  const d = DEFAULT_BUILDER_NOTIFICATION_PREFERENCES;
  return {
    newLeadEmail: row.newLeadEmail ?? d.newLeadEmail,
    needsYouDigest: row.needsYouDigest ?? d.needsYouDigest,
    billingEmail: row.billingEmail ?? d.billingEmail,
  };
}

function toRole(role: string): BuilderMemberRole {
  return role === 'builder_admin' ? 'builder_admin' : 'builder_member';
}

export function createDrizzleBuilderNotificationStore(deps: {
  readonly db: AppDb;
}): BuilderNotificationStore {
  const { db } = deps;

  const memberColumns = {
    userId: users.id,
    email: users.email,
    role: builderMemberships.role,
    newLeadEmail: builderNotificationPreferences.newLeadEmail,
    needsYouDigest: builderNotificationPreferences.needsYouDigest,
    billingEmail: builderNotificationPreferences.billingEmail,
  };

  function membersQuery(builderId: string) {
    return db
      .select(memberColumns)
      .from(builderMemberships)
      .innerJoin(users, eq(builderMemberships.userId, users.id))
      .leftJoin(
        builderNotificationPreferences,
        and(
          eq(builderNotificationPreferences.userId, builderMemberships.userId),
          eq(builderNotificationPreferences.builderId, builderMemberships.builderId),
        ),
      )
      .where(
        and(eq(builderMemberships.builderId, builderId), eq(users.status, 'active')),
      )
      .$dynamic();
  }

  function toMember(row: {
    userId: string;
    email: string;
    role: string;
  } & PrefsRow): NotificationMember {
    return {
      userId: row.userId,
      email: row.email,
      role: toRole(row.role),
      preferences: withDefaults(row),
    };
  }

  const builderColumns = {
    id: builders.id,
    tenantKey: builders.tenantKey,
    displayName: builders.displayName,
    status: builders.status,
  };

  return {
    async findBuilder(builderId) {
      const rows = await db
        .select(builderColumns)
        .from(builders)
        .where(eq(builders.id, builderId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findBuilderByTenantKey(tenantKey) {
      const rows = await db
        .select(builderColumns)
        .from(builders)
        .where(eq(builders.tenantKey, tenantKey))
        .limit(1);
      return rows[0] ?? null;
    },

    async listActiveMembers(builderId) {
      const rows = await membersQuery(builderId).orderBy(asc(users.email));
      return rows.map(toMember);
    },

    async findActiveMember(builderId, who) {
      const rows = await membersQuery(builderId)
        .where(
          and(
            eq(builderMemberships.builderId, builderId),
            eq(users.status, 'active'),
            'email' in who
              ? eq(users.email, who.email.trim().toLowerCase())
              : eq(users.id, who.userId),
          ),
        )
        .limit(1);
      return rows[0] ? toMember(rows[0]) : null;
    },

    async savePreferences(args) {
      const values = {
        newLeadEmail: args.preferences.newLeadEmail,
        needsYouDigest: args.preferences.needsYouDigest,
        billingEmail: args.preferences.billingEmail,
        updatedAt: args.at,
      };
      await db
        .insert(builderNotificationPreferences)
        .values({ userId: args.userId, builderId: args.builderId, ...values })
        .onConflictDoUpdate({
          target: [
            builderNotificationPreferences.userId,
            builderNotificationPreferences.builderId,
          ],
          set: values,
        });
    },

    async listDigestBuilders() {
      // The digest is opt-in, so only members WITH a saved row can be
      // subscribed — an inner join is exact.
      const rows = await db
        .selectDistinct(builderColumns)
        .from(builderNotificationPreferences)
        .innerJoin(builders, eq(builderNotificationPreferences.builderId, builders.id))
        .innerJoin(users, eq(builderNotificationPreferences.userId, users.id))
        .innerJoin(
          builderMemberships,
          and(
            eq(builderMemberships.userId, builderNotificationPreferences.userId),
            eq(builderMemberships.builderId, builderNotificationPreferences.builderId),
          ),
        )
        .where(
          and(
            eq(builderNotificationPreferences.needsYouDigest, true),
            eq(users.status, 'active'),
            eq(builders.status, 'active'),
          ),
        );
      return rows;
    },

    async findLead(leadId) {
      const rows = await db
        .select({
          id: leads.id,
          name: leads.name,
          builderId: leads.builderId,
          quarantined: leads.quarantined,
          discarded: leads.discarded,
          sandbox: leads.sandbox,
          addressKey: leads.addressKey,
          projectType: estimates.projectType,
        })
        .from(leads)
        .innerJoin(estimates, eq(leads.estimateId, estimates.id))
        .where(eq(leads.id, leadId))
        .limit(1);
      return rows[0] ?? null;
    },

    async enqueue(rows) {
      if (rows.length === 0) return;
      await db
        .insert(builderNotifications)
        .values(rows.map((row) => ({ ...row, status: 'pending' })))
        .onConflictDoNothing({ target: builderNotifications.dedupeKey });
    },

    async listPending(args) {
      const conditions = [
        eq(builderNotifications.status, 'pending'),
        gte(builderNotifications.createdAt, args.createdAfter),
        lt(builderNotifications.attempts, args.maxAttempts),
        or(
          isNull(builderNotifications.lastAttemptAt),
          lte(builderNotifications.lastAttemptAt, args.leaseCutoff),
        ),
      ];
      if (args.leadId !== undefined) {
        conditions.push(eq(builderNotifications.leadId, args.leadId));
      }
      if (args.dedupeKeys !== undefined) {
        if (args.dedupeKeys.length === 0) return [];
        conditions.push(inArray(builderNotifications.dedupeKey, [...args.dedupeKeys]));
      }
      const rows = await db
        .select({
          id: builderNotifications.id,
          dedupeKey: builderNotifications.dedupeKey,
          kind: builderNotifications.kind,
          builderId: builderNotifications.builderId,
          userId: builderNotifications.userId,
          leadId: builderNotifications.leadId,
          status: builderNotifications.status,
          attempts: builderNotifications.attempts,
          createdAt: builderNotifications.createdAt,
        })
        .from(builderNotifications)
        .where(and(...conditions))
        .orderBy(asc(builderNotifications.createdAt))
        .limit(args.limit);
      return rows.map((row) => ({
        ...row,
        kind: row.kind as BuilderNotificationKind,
        status: row.status as BuilderNotificationStatus,
      }));
    },

    async claim(args) {
      const rows = await db
        .update(builderNotifications)
        .set({
          attempts: sql`${builderNotifications.attempts} + 1`,
          lastAttemptAt: args.now,
        })
        .where(
          and(
            eq(builderNotifications.id, args.id),
            eq(builderNotifications.status, 'pending'),
            or(
              isNull(builderNotifications.lastAttemptAt),
              lte(builderNotifications.lastAttemptAt, args.leaseCutoff),
            ),
          ),
        )
        .returning({ id: builderNotifications.id });
      return rows.length > 0;
    },

    async finish(args) {
      await db
        .update(builderNotifications)
        .set({
          status: args.status,
          processedAt: args.at,
          lastErrorCode: args.errorCode ?? null,
        })
        .where(eq(builderNotifications.id, args.id));
    },

    async recordFailure(args) {
      // Clear the lease so the next timer tick may retry right away.
      await db
        .update(builderNotifications)
        .set({ lastErrorCode: args.errorCode, lastAttemptAt: null })
        .where(eq(builderNotifications.id, args.id));
    },
  };
}
