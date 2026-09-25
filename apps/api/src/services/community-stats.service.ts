/**
 * Community stats service (neighbourhood/01).
 *
 * Cache-first reads over the `community_stats` table — the API never calls
 * Socrata per-request. Rows are written by the seed script and the monthly
 * refresh timer.
 *
 * DB access lives here (and in composition.ts), never in routes — see
 * test/boundaries.test.ts.
 */
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { communityStats } from '../db/schema';
import type { CommunityStatRecord } from './community-stats/socrata-aggregates';

export type { CommunityStatRecord };

export interface CommunityStatsService {
  /** Null when no row exists for the slug. */
  getBySlug(slug: string): Promise<CommunityStatRecord | null>;
  /**
   * Idempotent upsert of computed rows (seed script + refresh timer).
   * Returns the number of rows written.
   */
  upsertMany(rows: readonly CommunityStatRecord[]): Promise<number>;
}

export interface CommunityStatsServiceDeps {
  readonly db: AppDb;
}

function toRecord(row: typeof communityStats.$inferSelect): CommunityStatRecord {
  return {
    slug: row.slug,
    name: row.name,
    avgAssessedValue: row.avgAssessedValue,
    assessmentCount: row.assessmentCount,
    avgLotSqft: row.avgLotSqft,
    refreshedAt: row.refreshedAt,
  };
}

export function createDrizzleCommunityStatsService(
  deps: CommunityStatsServiceDeps,
): CommunityStatsService {
  const { db } = deps;
  return {
    async getBySlug(slug: string): Promise<CommunityStatRecord | null> {
      const rows = await db
        .select()
        .from(communityStats)
        .where(eq(communityStats.slug, slug))
        .limit(1);
      return rows.length > 0 ? toRecord(rows[0]) : null;
    },

    async upsertMany(rows: readonly CommunityStatRecord[]): Promise<number> {
      for (const row of rows) {
        await db
          .insert(communityStats)
          .values({
            slug: row.slug,
            name: row.name,
            avgAssessedValue: row.avgAssessedValue,
            assessmentCount: row.assessmentCount,
            avgLotSqft: row.avgLotSqft,
            refreshedAt: row.refreshedAt,
          })
          .onConflictDoUpdate({
            target: communityStats.slug,
            set: {
              name: row.name,
              avgAssessedValue: row.avgAssessedValue,
              assessmentCount: row.assessmentCount,
              avgLotSqft: row.avgLotSqft,
              refreshedAt: row.refreshedAt,
            },
          });
      }
      return rows.length;
    },
  };
}
