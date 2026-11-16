/**
 * Household estimate listing (#800).
 *
 * One row per property (address key) the email has an estimate for, each
 * carrying that property's NEWEST estimate — the same estimate an owner
 * link for that property opens (`findNewestEstimateIdByEmailAndAddress`).
 * Quarantined (and therefore discarded) leads never appear. Erased leads
 * are deleted rows, so they cannot appear.
 *
 * The interface is what `MagicLinkService` depends on; unit tests fake it.
 * The Drizzle implementation is constructed once in composition.ts.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { estimates, leads } from '../db/schema';

export interface HouseholdEstimateRow {
  /** The lead whose estimate this is (the per-item handle). */
  readonly leadId: string;
  readonly addressKey: string;
  readonly estimateId: string;
  readonly projectType: string;
  readonly createdAt: Date;
  /** #793: sandbox lead — links minted for it are flagged for the purge. */
  readonly sandbox: boolean;
}

export interface HouseholdEstimatesStore {
  /**
   * Newest estimate per property for `email` (already normalized),
   * newest first, at most `limit` rows. Quarantined leads excluded.
   */
  listByEmail(args: {
    readonly email: string;
    readonly limit: number;
    /** Restrict to one property (non-household links list only their own). */
    readonly addressKey?: string;
  }): Promise<HouseholdEstimateRow[]>;
}

export interface DrizzleHouseholdEstimatesStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleHouseholdEstimatesStore(
  deps: DrizzleHouseholdEstimatesStoreDeps,
): HouseholdEstimatesStore {
  const { db } = deps;
  return {
    async listByEmail(args): Promise<HouseholdEstimateRow[]> {
      // DISTINCT ON keeps the newest estimate per address; the outer sort
      // (in JS — the distinct set is one row per property, small) orders
      // properties newest first.
      const rows = await db
        .selectDistinctOn([leads.addressKey], {
          leadId: leads.id,
          addressKey: leads.addressKey,
          estimateId: estimates.id,
          projectType: estimates.projectType,
          createdAt: estimates.createdAt,
          sandbox: leads.sandbox,
        })
        .from(leads)
        .innerJoin(estimates, eq(leads.estimateId, estimates.id))
        .where(
          and(
            eq(leads.email, args.email),
            eq(leads.quarantined, false),
            args.addressKey !== undefined
              ? eq(leads.addressKey, args.addressKey)
              : undefined,
          ),
        )
        .orderBy(leads.addressKey, desc(estimates.createdAt), desc(leads.createdAt));
      return rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, Math.max(0, args.limit));
    },
  };
}
