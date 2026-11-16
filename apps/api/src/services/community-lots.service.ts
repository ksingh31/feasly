/**
 * Community lot inventory — read service (#691).
 *
 * Cache-first: serves the lots the refresh timer stored; never calls the
 * City per request. A community is "known" when the last refresh covered
 * it (established infill communities only) — otherwise `null` (404).
 * Per-community lists are small (tens of lots), so filtering, sorting and
 * keyset paging run in-process on the community's rows (pure, tested in
 * lot-rules).
 */
import type { CommunityLotsConfig } from '../config';
import type { CommunityLotsStore } from './community-lots.store';
import {
  pageLots,
  type LotListFilters,
  type LotPage,
  type StoredCommunityLot,
} from './community-lots/lot-rules';

export { InvalidCursorError } from './community-lots/lot-rules';
export type { LotListFilters, StoredCommunityLot };

export interface CommunityLotsListResult {
  readonly city: string;
  readonly community: { readonly slug: string; readonly name: string };
  readonly refreshedAt: Date;
  readonly stale: boolean;
  readonly page: LotPage<StoredCommunityLot>;
}

/** Query as the route parsed it; `limit` is clamped here. */
export type CommunityLotsQuery = Omit<LotListFilters, 'limit'> & { readonly limit?: number };

export interface CommunityLotsService {
  /** Null when the community is not in the inventory. Throws InvalidCursorError. */
  list(slug: string, query: CommunityLotsQuery): Promise<CommunityLotsListResult | null>;
}

export interface CommunityLotsServiceDeps {
  readonly store: CommunityLotsStore;
  readonly config: Pick<CommunityLotsConfig, 'city' | 'staleAfterDays' | 'defaultLimit' | 'maxLimit'>;
  readonly clock?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCommunityLotsService(deps: CommunityLotsServiceDeps): CommunityLotsService {
  const { store, config, clock = () => new Date() } = deps;
  return {
    async list(slug, query) {
      const refresh = await store.getRefresh(config.city, slug);
      if (!refresh) return null;
      const lots = await store.listLots(config.city, slug);
      const maxLimit = Math.max(1, config.maxLimit);
      const limit = Math.min(query.limit ?? Math.min(config.defaultLimit, maxLimit), maxLimit);
      const page = pageLots(lots, { ...query, limit });
      return {
        city: config.city,
        community: { slug: refresh.communitySlug, name: refresh.communityName },
        refreshedAt: refresh.refreshedAt,
        stale: refresh.refreshedAt.getTime() < clock().getTime() - config.staleAfterDays * DAY_MS,
        page,
      };
    },
  };
}
