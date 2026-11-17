/**
 * Community match store (#778) — whole-city reads over tables other
 * features fill:
 *
 * - `amenities` tree-cover rows: one anchor per established community (#777)
 * - `community_lots` / `community_lot_refreshes`: listed lots (#691)
 * - `community_stats`: average lot size (neighbourhood/01)
 *
 * Read-only, a handful of queries per snapshot build (not per community),
 * so building the match snapshot for ~110 communities stays cheap. Only
 * services import this module (routes never touch the db).
 */
import { asc, eq } from 'drizzle-orm';
import { amenities, communityLotRefreshes, communityLots, communityStats } from '../../db/schema';
import { TREE_COVER_CATEGORY } from '../neighbourhood-data/categories';
import type { StoredCommunityAnchor } from '../neighbourhood-data/neighbourhood-data.store';

export interface StoredLotArea {
  readonly communitySlug: string;
  readonly lotSqft: number | null;
}

export interface StoredLotRefresh {
  readonly communitySlug: string;
  readonly refreshedAt: Date;
}

export interface StoredAvgLotSqft {
  readonly slug: string;
  readonly avgLotSqft: number | null;
}

export interface CommunityMatchStore {
  /** Every established community's anchor (City code order). */
  listCommunityAnchors(): Promise<readonly StoredCommunityAnchor[]>;
  /** Every listed lot's area in the city. */
  listLotAreas(city: string): Promise<readonly StoredLotArea[]>;
  /** One row per community the last lot refresh covered. */
  listLotRefreshes(city: string): Promise<readonly StoredLotRefresh[]>;
  /** Average lot size per community slug. */
  listAvgLotSqft(): Promise<readonly StoredAvgLotSqft[]>;
}

export interface DrizzleCommunityMatchStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleCommunityMatchStore(deps: DrizzleCommunityMatchStoreDeps): CommunityMatchStore {
  const { db } = deps;
  return {
    async listCommunityAnchors() {
      const t = amenities;
      const rows: Array<{
        communityCode: string | null;
        name: string;
        lat: number | null;
        lng: number | null;
        data: unknown;
        refreshedAt: Date;
      }> = await db
        .select({
          communityCode: t.communityCode,
          name: t.name,
          lat: t.lat,
          lng: t.lng,
          data: t.data,
          refreshedAt: t.refreshedAt,
        })
        .from(t)
        .where(eq(t.category, TREE_COVER_CATEGORY))
        .orderBy(asc(t.communityCode));
      const anchors: StoredCommunityAnchor[] = [];
      for (const row of rows) {
        if (!row.communityCode || row.lat === null || row.lng === null) continue;
        anchors.push({
          communityCode: row.communityCode,
          name: row.name,
          lat: row.lat,
          lng: row.lng,
          data: row.data,
          refreshedAt: row.refreshedAt,
        });
      }
      return anchors;
    },

    async listLotAreas(city) {
      return db
        .select({ communitySlug: communityLots.communitySlug, lotSqft: communityLots.lotSqft })
        .from(communityLots)
        .where(eq(communityLots.city, city));
    },

    async listLotRefreshes(city) {
      return db
        .select({
          communitySlug: communityLotRefreshes.communitySlug,
          refreshedAt: communityLotRefreshes.refreshedAt,
        })
        .from(communityLotRefreshes)
        .where(eq(communityLotRefreshes.city, city));
    },

    async listAvgLotSqft() {
      return db
        .select({ slug: communityStats.slug, avgLotSqft: communityStats.avgLotSqft })
        .from(communityStats);
    },
  };
}
