/**
 * Drizzle-backed community narrative store (#759).
 *
 * One row per (community_slug, period). `narrative` is the last successful
 * text for the period and survives later failed attempts; `status` reflects
 * the latest attempt. Reports read the newest row that has a narrative, so
 * a community whose generation failed this month keeps serving last month's.
 *
 * Only services import from this module (routes never touch the db).
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { communityNarratives, communityStats } from '../db/schema';

export type CommunityNarrativeStatus = 'succeeded' | 'failed' | 'stale';

export interface CommunityNarrativeRecord {
  readonly communitySlug: string;
  readonly period: string;
  readonly narrative: string | null;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly status: CommunityNarrativeStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly generatedAt: Date | null;
  readonly updatedAt: Date;
}

/** A community covered by `community_stats` (the generation input). */
export interface CoveredCommunity {
  readonly slug: string;
  readonly name: string;
  readonly avgAssessedValue: number;
  readonly assessmentCount: number;
  readonly avgLotSqft: number | null;
  readonly refreshedAt: Date;
}

export interface CommunityNarrativeStore {
  /** Every community with a stats row, ordered by slug. */
  listCoveredCommunities(): Promise<readonly CoveredCommunity[]>;
  /** One covered community, or null. */
  getCoveredCommunity(slug: string): Promise<CoveredCommunity | null>;
  /** Rows for one period. */
  listForPeriod(period: string): Promise<readonly CommunityNarrativeRecord[]>;
  /** Rows marked 'stale' (admin asked to regenerate), any period. */
  listStale(): Promise<readonly CommunityNarrativeRecord[]>;
  /** Newest row per community (for the admin status view). */
  listLatestPerCommunity(): Promise<readonly CommunityNarrativeRecord[]>;
  /**
   * The narrative to serve for a community: the newest row (by period)
   * whose narrative is set — one indexed read. Null when none exists.
   */
  findServable(slug: string): Promise<CommunityNarrativeRecord | null>;
  /** Upsert a successful generation (replaces the text, status 'succeeded'). */
  recordSuccess(args: {
    readonly communitySlug: string;
    readonly period: string;
    readonly narrative: string;
    readonly model: string;
    readonly promptVersion: string;
    readonly at: Date;
  }): Promise<void>;
  /** Upsert a failed attempt; an existing narrative is kept. */
  recordFailure(args: {
    readonly communitySlug: string;
    readonly period: string;
    readonly promptVersion: string;
    readonly error: string;
    readonly at: Date;
  }): Promise<void>;
  /**
   * Mark (community, period) rows 'stale' so the next attempt regenerates
   * them, inserting placeholder rows for communities without one. Returns
   * the number of rows marked.
   */
  markStale(args: {
    readonly communitySlugs: readonly string[];
    readonly period: string;
    readonly promptVersion: string;
    readonly at: Date;
  }): Promise<number>;
}

export interface DrizzleCommunityNarrativeStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

type Row = typeof communityNarratives.$inferSelect;

function toRecord(row: Row): CommunityNarrativeRecord {
  return {
    communitySlug: row.communitySlug,
    period: row.period,
    narrative: row.narrative,
    model: row.model,
    promptVersion: row.promptVersion,
    status: row.status as CommunityNarrativeStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt,
  };
}

function toCovered(row: typeof communityStats.$inferSelect): CoveredCommunity {
  return {
    slug: row.slug,
    name: row.name,
    avgAssessedValue: row.avgAssessedValue,
    assessmentCount: row.assessmentCount,
    avgLotSqft: row.avgLotSqft,
    refreshedAt: row.refreshedAt,
  };
}

export function createDrizzleCommunityNarrativeStore(
  deps: DrizzleCommunityNarrativeStoreDeps,
): CommunityNarrativeStore {
  const { db } = deps;
  const t = communityNarratives;
  return {
    async listCoveredCommunities() {
      const rows: Array<typeof communityStats.$inferSelect> = await db
        .select()
        .from(communityStats)
        .orderBy(communityStats.slug);
      return rows.map(toCovered);
    },

    async getCoveredCommunity(slug) {
      const rows: Array<typeof communityStats.$inferSelect> = await db
        .select()
        .from(communityStats)
        .where(eq(communityStats.slug, slug))
        .limit(1);
      return rows[0] ? toCovered(rows[0]) : null;
    },

    async listForPeriod(period) {
      const rows: Row[] = await db.select().from(t).where(eq(t.period, period));
      return rows.map(toRecord);
    },

    async listStale() {
      const rows: Row[] = await db
        .select()
        .from(t)
        .where(eq(t.status, 'stale'))
        .orderBy(t.communitySlug);
      return rows.map(toRecord);
    },

    async listLatestPerCommunity() {
      const rows: Row[] = await db
        .selectDistinctOn([t.communitySlug])
        .from(t)
        .orderBy(t.communitySlug, desc(t.period));
      return rows.map(toRecord);
    },

    async findServable(slug) {
      const rows: Row[] = await db
        .select()
        .from(t)
        .where(and(eq(t.communitySlug, slug), isNotNull(t.narrative)))
        .orderBy(desc(t.period))
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async recordSuccess(args) {
      await db
        .insert(t)
        .values({
          communitySlug: args.communitySlug,
          period: args.period,
          narrative: args.narrative,
          model: args.model,
          promptVersion: args.promptVersion,
          status: 'succeeded',
          attempts: 1,
          lastError: null,
          generatedAt: args.at,
          updatedAt: args.at,
        })
        .onConflictDoUpdate({
          target: [t.communitySlug, t.period],
          set: {
            narrative: args.narrative,
            model: args.model,
            promptVersion: args.promptVersion,
            status: 'succeeded',
            attempts: sql`${t.attempts} + 1`,
            lastError: null,
            generatedAt: args.at,
            updatedAt: args.at,
          },
        });
    },

    async recordFailure(args) {
      await db
        .insert(t)
        .values({
          communitySlug: args.communitySlug,
          period: args.period,
          narrative: null,
          model: null,
          promptVersion: args.promptVersion,
          status: 'failed',
          attempts: 1,
          lastError: args.error,
          generatedAt: null,
          updatedAt: args.at,
        })
        .onConflictDoUpdate({
          target: [t.communitySlug, t.period],
          // narrative / model / generated_at are deliberately untouched:
          // the last good text for the period keeps being served.
          set: {
            status: 'failed',
            attempts: sql`${t.attempts} + 1`,
            lastError: args.error,
            updatedAt: args.at,
          },
        });
    },

    async markStale(args) {
      if (args.communitySlugs.length === 0) return 0;
      await db
        .insert(t)
        .values(
          args.communitySlugs.map((communitySlug) => ({
            communitySlug,
            period: args.period,
            promptVersion: args.promptVersion,
            status: 'stale',
            attempts: 0,
            updatedAt: args.at,
          })),
        )
        .onConflictDoNothing();
      await db
        .update(t)
        .set({ status: 'stale', updatedAt: args.at })
        .where(
          and(
            eq(t.period, args.period),
            inArray(t.communitySlug, [...args.communitySlugs]),
          ),
        );
      return args.communitySlugs.length;
    },
  };
}
