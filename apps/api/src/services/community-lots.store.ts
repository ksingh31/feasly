/**
 * Community lot inventory store (#691) — the only code that touches the
 * `community_lots` / `community_lot_refreshes` tables.
 *
 * A community is written in ONE transaction (inserts, updates, removals and
 * its refresh row), so a failure mid-write leaves the previous inventory
 * intact — never a partial wipe. Unchanged lots are not touched, so a
 * re-run over unchanged source data changes no lot rows.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { communityLotRefreshes, communityLots } from '../db/schema';
import type {
  CommunityLotRecord,
  LotDiff,
  StoredCommunityLot,
} from './community-lots/lot-rules';

/** One community the last refresh covered. */
export interface CommunityLotRefreshRecord {
  readonly city: string;
  readonly communitySlug: string;
  readonly communityName: string;
  readonly rollYear: string;
  readonly lotCount: number;
  readonly refreshedAt: Date;
}

export interface ApplyCommunityInput {
  readonly city: string;
  readonly communitySlug: string;
  readonly communityName: string;
  readonly rollYear: string;
  readonly refreshedAt: Date;
  readonly diff: LotDiff;
  /** Lots listed for the community after this write. */
  readonly lotCount: number;
}

export interface CommunityLotsStore {
  getRefresh(city: string, communitySlug: string): Promise<CommunityLotRefreshRecord | null>;
  listLots(city: string, communitySlug: string): Promise<StoredCommunityLot[]>;
  /** Apply one community's diff + refresh row atomically. */
  applyCommunity(input: ApplyCommunityInput): Promise<void>;
  /**
   * Remove communities (lots + refresh rows) no longer in the inventory —
   * e.g. a boundary reclassified out of the established set. Returns the
   * number of communities removed.
   */
  removeCommunitiesExcept(city: string, keepSlugs: readonly string[]): Promise<number>;
}

export interface CommunityLotsStoreDeps {
  readonly db: AppDb;
}

export function lotId(city: string, rollNumber: string): string {
  return `${city}:${rollNumber}`;
}

function refreshId(city: string, slug: string): string {
  return `${city}:${slug}`;
}

function toValues(lot: CommunityLotRecord) {
  return {
    communitySlug: lot.communitySlug,
    address: lot.address,
    lotSqft: lot.lotSqft,
    assessedValue: lot.assessedValue,
    rollYear: lot.rollYear,
    district: lot.district,
    districtSource: lot.districtSource,
    kind: lot.kind,
    latitude: lot.latitude,
    longitude: lot.longitude,
  };
}

function toStored(row: typeof communityLots.$inferSelect): StoredCommunityLot {
  return {
    city: row.city,
    communitySlug: row.communitySlug,
    rollNumber: row.rollNumber,
    address: row.address,
    lotSqft: row.lotSqft,
    assessedValue: row.assessedValue,
    rollYear: row.rollYear,
    district: row.district,
    districtSource:
      row.districtSource === 'assessment-roll' ? 'assessment-roll' : 'land-use-districts',
    kind: row.kind === 'candidate' ? 'candidate' : 'vacant',
    latitude: row.latitude,
    longitude: row.longitude,
    firstSeenAt: row.firstSeenAt,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleCommunityLotsStore(deps: CommunityLotsStoreDeps): CommunityLotsStore {
  const { db } = deps;
  return {
    async getRefresh(city, communitySlug) {
      const rows = await db
        .select()
        .from(communityLotRefreshes)
        .where(eq(communityLotRefreshes.id, refreshId(city, communitySlug)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        city: row.city,
        communitySlug: row.communitySlug,
        communityName: row.communityName,
        rollYear: row.rollYear,
        lotCount: row.lotCount,
        refreshedAt: row.refreshedAt,
      };
    },

    async listLots(city, communitySlug) {
      const rows = await db
        .select()
        .from(communityLots)
        .where(and(eq(communityLots.city, city), eq(communityLots.communitySlug, communitySlug)));
      return rows.map(toStored);
    },

    async applyCommunity(input) {
      const { city, communitySlug, refreshedAt, diff } = input;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.transaction(async (tx: any) => {
        for (const lot of diff.insert) {
          const values = toValues(lot);
          await tx
            .insert(communityLots)
            .values({
              id: lotId(city, lot.rollNumber),
              city,
              rollNumber: lot.rollNumber,
              ...values,
              firstSeenAt: refreshedAt,
              updatedAt: refreshedAt,
            })
            // A parcel re-assigned from another community moves here.
            .onConflictDoUpdate({
              target: communityLots.id,
              set: { ...values, updatedAt: refreshedAt },
            });
        }
        for (const lot of diff.update) {
          await tx
            .update(communityLots)
            .set({ ...toValues(lot), updatedAt: refreshedAt })
            .where(eq(communityLots.id, lotId(city, lot.rollNumber)));
        }
        if (diff.remove.length > 0) {
          await tx
            .delete(communityLots)
            .where(
              and(
                eq(communityLots.city, city),
                eq(communityLots.communitySlug, communitySlug),
                inArray(communityLots.rollNumber, [...diff.remove]),
              ),
            );
        }
        const refresh = {
          city,
          communitySlug,
          communityName: input.communityName,
          rollYear: input.rollYear,
          lotCount: input.lotCount,
          refreshedAt,
        };
        await tx
          .insert(communityLotRefreshes)
          .values({ id: refreshId(city, communitySlug), ...refresh })
          .onConflictDoUpdate({ target: communityLotRefreshes.id, set: refresh });
      });
    },

    async removeCommunitiesExcept(city, keepSlugs) {
      // Callers guarantee a non-empty keep list (an empty source never prunes).
      if (keepSlugs.length === 0) return 0;
      const keep = [...keepSlugs];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return db.transaction(async (tx: any) => {
        await tx
          .delete(communityLots)
          .where(and(eq(communityLots.city, city), notInArray(communityLots.communitySlug, keep)));
        const removed = await tx
          .delete(communityLotRefreshes)
          .where(
            and(
              eq(communityLotRefreshes.city, city),
              notInArray(communityLotRefreshes.communitySlug, keep),
            ),
          )
          .returning({ id: communityLotRefreshes.id });
        return removed.length as number;
      });
    },
  };
}
