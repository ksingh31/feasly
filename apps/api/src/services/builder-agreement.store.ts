/**
 * Platform agreement + onboarding persistence (#722).
 *
 * `builder_agreement_acceptances` is an APPEND-ONLY legal record: this
 * store exposes `insert` and reads only — there is deliberately no update
 * or delete method, and none may be added.
 *
 * The onboarding reads (team size, pending invitations, embed signal) live
 * here too so the onboarding service never touches `db/`.
 */
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import {
  analyticsEvents,
  builderAgreementAcceptances,
  builderMemberships,
  builders,
  invitations,
  leads,
  users,
} from '../db/schema';

export interface AgreementAcceptanceRecord {
  readonly id: string;
  readonly builderId: string;
  readonly version: string;
  readonly acceptedAt: Date;
  readonly acceptedByUserId: string | null;
  /** Email snapshot taken at acceptance time. */
  readonly acceptedByEmail: string | null;
  /** Current display name of the accepting user (null if deleted). */
  readonly acceptedByName: string | null;
}

export interface NewAgreementAcceptance {
  readonly id: string;
  readonly builderId: string;
  readonly version: string;
  readonly acceptedAt: Date;
  readonly acceptedByUserId: string;
  readonly acceptedByEmail: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface BuilderAgreementStore {
  /** Append one acceptance row. Insert-only — the record is never edited. */
  insert(row: NewAgreementAcceptance): Promise<void>;
  /**
   * Most recent acceptance for the builder; restricted to `version` when
   * given. Null when none.
   */
  findLatest(
    builderId: string,
    version?: string,
  ): Promise<AgreementAcceptanceRecord | null>;
  /**
   * True when the builder identified by `tenantKey` has an acceptance of
   * `version` (one join; the billing gate keys on tenant).
   */
  hasAcceptanceForTenant(tenantKey: string, version: string): Promise<boolean>;
}

export interface BuilderOnboardingStore {
  /** Number of memberships in the builder org (any role). */
  countMembers(builderId: string): Promise<number>;
  /** True when the org has a pending invitation that has not expired. */
  hasPendingInvitation(builderId: string, now: Date): Promise<boolean>;
  /**
   * Embed install signal (#724 will add a dedicated one): a non-sandbox
   * lead captured through the embed for this builder, or an `embed_loaded`
   * analytics event carrying its tenant key.
   */
  hasEmbedSignal(builderId: string, tenantKey: string): Promise<boolean>;
}

export interface DrizzleBuilderAgreementStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleBuilderAgreementStore(
  deps: DrizzleBuilderAgreementStoreDeps,
): BuilderAgreementStore {
  const { db } = deps;
  return {
    async insert(row: NewAgreementAcceptance): Promise<void> {
      await db.insert(builderAgreementAcceptances).values({
        id: row.id,
        builderId: row.builderId,
        version: row.version,
        acceptedAt: row.acceptedAt,
        acceptedByUserId: row.acceptedByUserId,
        acceptedByEmail: row.acceptedByEmail,
        ip: row.ip,
        userAgent: row.userAgent,
      });
    },

    async findLatest(
      builderId: string,
      version?: string,
    ): Promise<AgreementAcceptanceRecord | null> {
      const where =
        version === undefined
          ? eq(builderAgreementAcceptances.builderId, builderId)
          : and(
              eq(builderAgreementAcceptances.builderId, builderId),
              eq(builderAgreementAcceptances.version, version),
            );
      const rows = await db
        .select({
          id: builderAgreementAcceptances.id,
          builderId: builderAgreementAcceptances.builderId,
          version: builderAgreementAcceptances.version,
          acceptedAt: builderAgreementAcceptances.acceptedAt,
          acceptedByUserId: builderAgreementAcceptances.acceptedByUserId,
          acceptedByEmail: builderAgreementAcceptances.acceptedByEmail,
          acceptedByName: users.name,
        })
        .from(builderAgreementAcceptances)
        .leftJoin(
          users,
          eq(users.id, builderAgreementAcceptances.acceptedByUserId),
        )
        .where(where)
        .orderBy(desc(builderAgreementAcceptances.acceptedAt))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        builderId: row.builderId,
        version: row.version,
        acceptedAt: row.acceptedAt,
        acceptedByUserId: row.acceptedByUserId,
        acceptedByEmail: row.acceptedByEmail,
        acceptedByName: row.acceptedByName ?? null,
      };
    },

    async hasAcceptanceForTenant(
      tenantKey: string,
      version: string,
    ): Promise<boolean> {
      const rows = await db
        .select({ id: builderAgreementAcceptances.id })
        .from(builderAgreementAcceptances)
        .innerJoin(builders, eq(builders.id, builderAgreementAcceptances.builderId))
        .where(
          and(
            eq(builders.tenantKey, tenantKey),
            eq(builderAgreementAcceptances.version, version),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

export function createDrizzleBuilderOnboardingStore(
  deps: DrizzleBuilderAgreementStoreDeps,
): BuilderOnboardingStore {
  const { db } = deps;
  return {
    async countMembers(builderId: string): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(builderMemberships)
        .where(eq(builderMemberships.builderId, builderId));
      return Number(rows[0]?.n ?? 0);
    },

    async hasPendingInvitation(builderId: string, now: Date): Promise<boolean> {
      const rows = await db
        .select({ id: invitations.id })
        .from(invitations)
        .where(
          and(
            eq(invitations.builderId, builderId),
            eq(invitations.status, 'pending'),
            gt(invitations.expiresAt, now),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async hasEmbedSignal(builderId: string, tenantKey: string): Promise<boolean> {
      const leadRows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.source, 'embed'),
            eq(leads.sandbox, false),
            sql`(${leads.builderId} = ${builderId} OR ${leads.tenantKey} = ${tenantKey})`,
          ),
        )
        .limit(1);
      if (leadRows.length > 0) return true;
      const eventRows = await db
        .select({ id: analyticsEvents.id })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.event, 'embed_loaded'),
            eq(analyticsEvents.tenantKey, tenantKey),
            eq(analyticsEvents.sandbox, false),
          ),
        )
        .limit(1);
      return eventRows.length > 0;
    },
  };
}
