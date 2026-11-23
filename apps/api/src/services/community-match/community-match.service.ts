/**
 * Community match service (#778) — POST /api/v1/communities/match.
 *
 * Request path = pure scoring over a precomputed snapshot:
 *
 * 1. The snapshot holds every established community's inputs (amenity
 *    nearest distances + tree cover from the #777 community metrics,
 *    typically designated grade bands from #775, listed lot areas from
 *    #691, average lot size from community_stats). It is built from our
 *    tables only — this service has no provider dependency, so a visitor
 *    never triggers an outside call.
 * 2. The snapshot is reused from this instance's memory, then from the
 *    shared City-data cache (#756), and rebuilt only when both expired. So
 *    a warm request does no I/O at all and a request on a fresh instance
 *    does one cache read — the p95 budget (300 ms for 110 communities) is
 *    spent on in-memory scoring.
 * 3. `rankCommunities` (pure, scoring.ts) ranks; the cost engine prices the
 *    typical new-build range on each community's average lot. Every dollar
 *    figure comes from packages/cost-engine.
 */
import {
  DESIGNATION_GRADE_BANDS,
  type CommunityCompareResponse,
  type CommunityMatchBuildBasis,
  type CommunityMatchResponse,
  type CommunityMatchResult,
  type DesignationGradeBand,
} from '@feasly/contracts';
import { calculateBuildBand, type CostData } from '@feasly/cost-engine';
import type { CommunityMatchConfig } from '../../config';
import type { CityDataCacheStore } from '../city-data-cache.store';
import { toSlug } from '../community-stats/socrata-aggregates';
import type { NeighbourhoodDataStore } from '../neighbourhood-data/neighbourhood-data.store';
import type { NeighbourhoodReadService } from '../neighbourhood-data/neighbourhood-read.service';
import type { CommunityMatchStore } from './community-match.store';
import { buildCompareRows, UnknownCommunityError } from './compare';
import {
  priorityDefinitions,
  rankCommunities,
  type CommunityMatchInput,
  type MatchFilters,
  type MatchPriority,
  type PriorityDefinition,
  type ScoringConfig,
} from './scoring';

export { UnknownPriorityError } from './scoring';
export { UnknownCommunityError } from './compare';

/** Shared-cache dataset id for the match snapshot (#756 table). */
export const COMMUNITY_MATCH_CACHE_DATASET = 'community-match-snapshot';
/** Bump when the snapshot shape changes (older cached payloads are ignored). */
export const COMMUNITY_MATCH_SNAPSHOT_VERSION = 1;

export const COMMUNITY_COMPARE_DISCLAIMER =
  'Compared from City of Calgary open data that Feasly refreshes monthly (lots weekly). ' +
  'Schools are typically designated and designations can change, so confirm with the board. ' +
  'Distances are straight-line from the community centre, not travel times. New-build ranges ' +
  'are estimates for the house described, not quotes.';

export const COMMUNITY_MATCH_DISCLAIMER =
  'Matches are scored from City of Calgary open data that Feasly refreshes monthly ' +
  '(lots weekly). Distances are straight-line from the community centre, not travel ' +
  'times. Schools are typically designated — designations can differ by address, so ' +
  'confirm with the board. Lot frontage is estimated from lot area. New-build ranges ' +
  'are typical figures for the house described, not a quote.';

export interface SnapshotCommunity extends CommunityMatchInput {
  readonly avgLotSqft: number | null;
}

export interface CommunityMatchSnapshot {
  readonly version: number;
  readonly builtAt: string;
  readonly dataRefreshedAt: string | null;
  readonly communities: readonly SnapshotCommunity[];
}

export interface CommunityMatchQuery {
  readonly priorities: readonly MatchPriority[];
  readonly filters?: MatchFilters;
  readonly limit?: number;
}

export interface CommunityMatchService {
  /** @throws UnknownPriorityError for a priority key with no definition. */
  match(query: CommunityMatchQuery): Promise<CommunityMatchResponse>;
  /**
   * Side-by-side rows for 2+ communities by slug, in the order given (#780).
   * @throws UnknownCommunityError for a slug that is not an established community.
   */
  compare(slugs: readonly string[]): Promise<CommunityCompareResponse>;
  /** The priorities a visitor can pick (amenity categories from config + fixed). */
  priorities(): readonly PriorityDefinition[];
}

export interface CommunityMatchServiceDeps {
  readonly store: CommunityMatchStore;
  readonly designations: Pick<NeighbourhoodDataStore, 'listDesignations'>;
  readonly living: Pick<NeighbourhoodReadService, 'getCommunityLivingMetrics'>;
  /** Shared City-data cache (#756); failures fall back to building. */
  readonly cache?: Pick<CityDataCacheStore, 'get' | 'put'>;
  readonly costData: CostData;
  readonly config: CommunityMatchConfig;
  /** City key the lot inventory is stored under. */
  readonly city: string;
  /** Neighbourhood config: amenity categories + their search radius. */
  readonly amenityCategories: readonly { readonly key: string; readonly label: string }[];
  readonly amenitySearchRadiusM: number;
  readonly clock?: () => Date;
  readonly logWarning?: (message: string) => void;
}

function isBand(value: unknown): value is DesignationGradeBand {
  return typeof value === 'string' && (DESIGNATION_GRADE_BANDS as readonly string[]).includes(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function isSnapshot(value: unknown): value is CommunityMatchSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['version'] === COMMUNITY_MATCH_SNAPSHOT_VERSION && Array.isArray(v['communities']);
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

export function createCommunityMatchService(deps: CommunityMatchServiceDeps): CommunityMatchService {
  const {
    store,
    designations,
    living,
    cache,
    costData,
    config,
    city,
    amenityCategories,
    amenitySearchRadiusM,
    clock = () => new Date(),
    logWarning = (message: string) => console.warn(message),
  } = deps;

  const definitions = priorityDefinitions(amenityCategories);
  const scoring: ScoringConfig = {
    mustWeight: config.mustWeight,
    niceWeight: config.niceWeight,
    nearRadiusM: config.nearRadiusM,
    searchRadiusM: amenitySearchRadiusM,
    treeCoverScores: config.treeCoverScores,
    typicalLotDepthFt: config.typicalLotDepthFt,
    maxReasons: config.maxReasons,
  };

  let memo: { snapshot: CommunityMatchSnapshot; expiresAt: number } | undefined;
  let inflight: Promise<CommunityMatchSnapshot> | undefined;

  async function buildSnapshot(now: Date): Promise<CommunityMatchSnapshot> {
    const [anchors, designationRows, lotAreas, lotRefreshes, avgRows] = await Promise.all([
      store.listCommunityAnchors(),
      designations.listDesignations(),
      store.listLotAreas(city),
      store.listLotRefreshes(city),
      store.listAvgLotSqft(),
    ]);

    const bandsByCode = new Map<string, Set<DesignationGradeBand>>();
    for (const row of designationRows) {
      if (!row.communityCode || !isBand(row.gradeBand)) continue;
      const code = row.communityCode.toUpperCase();
      const set = bandsByCode.get(code) ?? new Set<DesignationGradeBand>();
      set.add(row.gradeBand);
      bandsByCode.set(code, set);
    }
    const lotsBySlug = new Map<string, (number | null)[]>();
    for (const lot of lotAreas) {
      const list = lotsBySlug.get(lot.communitySlug) ?? [];
      list.push(lot.lotSqft);
      lotsBySlug.set(lot.communitySlug, list);
    }
    const refreshedBySlug = new Map(lotRefreshes.map((r) => [r.communitySlug, r.refreshedAt.toISOString()]));
    const avgBySlug = new Map(avgRows.map((r) => [r.slug, r.avgLotSqft]));

    let dataRefreshedAt: string | null = null;
    const communities = await mapBounded(anchors, config.snapshotConcurrency, async (anchor) => {
      const metrics = await living.getCommunityLivingMetrics(anchor.communityCode);
      const dataSlug = (anchor.data as { slug?: unknown } | null)?.slug;
      const slug = typeof dataSlug === 'string' && dataSlug.length > 0 ? dataSlug : toSlug(anchor.name);
      const amenityNearestM: Record<string, number | null> = {};
      for (const a of metrics.amenities) amenityNearestM[a.category] = a.nearest?.distanceM ?? null;
      const refreshed = anchor.refreshedAt.toISOString();
      if (dataRefreshedAt === null || refreshed > dataRefreshedAt) dataRefreshedAt = refreshed;
      const bands = bandsByCode.get(anchor.communityCode.toUpperCase());
      const community: SnapshotCommunity = {
        communityCode: anchor.communityCode,
        slug,
        name: anchor.name,
        amenityNearestM,
        treeCover: metrics.treeCover
          ? { level: metrics.treeCover.level, treesPerHa: metrics.treeCover.treesPerHa }
          : null,
        designatedBands: DESIGNATION_GRADE_BANDS.filter((b) => bands?.has(b)),
        lotSqft: lotsBySlug.get(slug) ?? [],
        lotsRefreshedAt: refreshedBySlug.get(slug) ?? null,
        avgLotSqft: avgBySlug.get(slug) ?? null,
      };
      return community;
    });

    return {
      version: COMMUNITY_MATCH_SNAPSHOT_VERSION,
      builtAt: now.toISOString(),
      dataRefreshedAt,
      communities,
    };
  }

  async function loadSnapshot(): Promise<CommunityMatchSnapshot> {
    const now = clock();
    if (memo && memo.expiresAt > now.getTime()) return memo.snapshot;
    if (inflight) return inflight;
    inflight = (async () => {
      let snapshot: CommunityMatchSnapshot | undefined;
      if (cache) {
        try {
          const cached = await cache.get(COMMUNITY_MATCH_CACHE_DATASET, 'all', now);
          if (isSnapshot(cached)) snapshot = cached;
        } catch (error) {
          logWarning(`community-match: snapshot cache read failed (${errorName(error)})`);
        }
      }
      if (!snapshot) {
        snapshot = await buildSnapshot(now);
        // An empty snapshot (data not loaded yet) is not cached.
        if (cache && snapshot.communities.length > 0) {
          try {
            await cache.put(
              COMMUNITY_MATCH_CACHE_DATASET,
              'all',
              snapshot,
              new Date(now.getTime() + config.snapshotTtlMs),
            );
          } catch (error) {
            logWarning(`community-match: snapshot cache write failed (${errorName(error)})`);
          }
        }
      }
      if (config.memoryTtlMs > 0 && snapshot.communities.length > 0) {
        memo = { snapshot, expiresAt: now.getTime() + config.memoryTtlMs };
      }
      return snapshot;
    })();
    try {
      return await inflight;
    } finally {
      inflight = undefined;
    }
  }

  /** Cost engine: typical new-build band on the community's average lot. */
  const buildRanges = new Map<number, { low: number; high: number }>();
  function typicalNewBuild(avgLotSqft: number | null): { low: number; high: number } | null {
    if (avgLotSqft === null || !Number.isFinite(avgLotSqft) || avgLotSqft <= 0) return null;
    const cached = buildRanges.get(avgLotSqft);
    if (cached) return cached;
    const band = calculateBuildBand(config.buildSqft, avgLotSqft, config.buildTier, costData);
    const range = { low: band.low, high: band.high };
    buildRanges.set(avgLotSqft, range);
    return range;
  }

  function buildBasis(): CommunityMatchBuildBasis {
    return {
      buildSqft: config.buildSqft,
      tier: config.buildTier,
      costDataVersion: costData.version,
      calibrated: costData.calibrated,
    };
  }

  return {
    priorities: () => definitions,

    async compare(slugs) {
      const snapshot = await loadSnapshot();
      const bySlug = new Map(snapshot.communities.map((c) => [c.slug, c]));
      const unknown = slugs.filter((slug) => !bySlug.has(slug));
      if (unknown.length > 0) throw new UnknownCommunityError(unknown);
      const picked = slugs.map((slug) => bySlug.get(slug)!);
      const rows = buildCompareRows(
        picked.map((c) => ({ ...c, typicalNewBuild: typicalNewBuild(c.avgLotSqft) })),
        { amenityCategories, searchRadiusM: amenitySearchRadiusM },
      );
      return {
        communities: picked.map((c) => ({ communityCode: c.communityCode, name: c.name, slug: c.slug })),
        rows,
        buildBasis: buildBasis(),
        distanceBasis: 'straight-line',
        dataRefreshedAt: snapshot.dataRefreshedAt,
        disclaimer: COMMUNITY_COMPARE_DISCLAIMER,
      };
    },

    async match(query) {
      const snapshot = await loadSnapshot();
      const filters = query.filters ?? {};
      const ranked = rankCommunities(snapshot.communities, query.priorities, filters, definitions, scoring);
      const limit = Math.min(query.limit ?? config.defaultLimit, config.maxLimit);
      const results: CommunityMatchResult[] = ranked.slice(0, limit).map((r) => {
        const c = r.input as SnapshotCommunity;
        return {
          rank: r.rank,
          communityCode: c.communityCode,
          name: c.name,
          slug: c.slug,
          match: r.match,
          passesMustHaves: r.passesMustHaves,
          reasons: r.reasons,
          misses: r.misses,
          lots: { listed: r.lots.listed, matching: r.lots.matching, refreshedAt: c.lotsRefreshedAt },
          typicalNewBuild: typicalNewBuild(c.avgLotSqft),
        };
      });
      return {
        results,
        total: ranked.length,
        buildBasis: buildBasis(),
        distanceBasis: 'straight-line',
        frontageBasis: 'estimated-from-lot-area',
        dataRefreshedAt: snapshot.dataRefreshedAt,
        disclaimer: COMMUNITY_MATCH_DISCLAIMER,
      };
    },
  };
}
