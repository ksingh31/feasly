/**
 * Neighbourhood data reads (#773) — the request-path side.
 *
 * Serves ONLY from our tables (filled by the monthly refresh job). It has no
 * provider dependency at all, so a visitor can never trigger an outside call
 * (test/neighbourhood-data.read.test.ts asserts zero provider calls, and the
 * boundary test asserts this module never imports the providers).
 *
 * Per-address metrics are computed on demand from the stored schools and
 * amenities, then cached in `lot_living_metrics` until the TTL from config.
 * Straight-line distances only — never travel times, never ratings claims.
 *
 * Community metrics (#777) are computed from the stored amenities around the
 * community centre (its `tree-cover` anchor row) and reused from the shared
 * City-data cache (#756) for `communityMetricsTtlMs`.
 */
import { haversineMeters } from '../../lib/geo';
import type { CityDataCacheStore } from '../city-data-cache.store';
import type { BoundingBox, NeighbourhoodDataStore } from './neighbourhood-data.store';

export interface NearbySchool {
  readonly id: string;
  readonly name: string;
  readonly board: string | null;
  readonly grades: string | null;
  readonly distanceM: number;
}

export interface LotLivingMetrics {
  readonly radiusM: number;
  /** Schools within the radius, nearest first. */
  readonly schools: readonly NearbySchool[];
  /** Amenity count within the radius, by category. */
  readonly amenityCounts: Readonly<Record<string, number>>;
  readonly computedAt: string;
}

/** #777: one amenity category around a community centre. */
export interface CommunityAmenityMetric {
  readonly category: string;
  readonly label: string;
  /** Nearest within the search radius; null when none. */
  readonly nearest: { readonly name: string; readonly distanceM: number } | null;
  /** Count within each configured radius, smallest radius first. */
  readonly counts: readonly { readonly radiusM: number; readonly count: number }[];
}

export type TreeCoverLevel = 'low' | 'moderate' | 'high';

/** #777: City-maintained public trees per hectare (not a measured canopy). */
export interface CommunityTreeCover {
  readonly publicTrees: number;
  readonly areaHa: number;
  readonly treesPerHa: number;
  readonly level: TreeCoverLevel;
}

export interface CommunityLivingMetrics {
  readonly communityCode: string;
  /** #777: City community name/slug; null when the community has no anchor row. */
  readonly name: string | null;
  readonly slug: string | null;
  /** #777: straight-line search radius for `nearest`. */
  readonly searchRadiusM: number;
  /** #777: one entry per configured category, in config order (empty without an anchor). */
  readonly amenities: readonly CommunityAmenityMetric[];
  readonly treeCover: CommunityTreeCover | null;
  /** When the amenity data behind these metrics was last refreshed. */
  readonly dataRefreshedAt: string | null;
  /** Metric name ('commute', 'reviews') → stored data (absent when none). */
  readonly metrics: Readonly<Record<string, { readonly source: string; readonly data: unknown }>>;
}

/** Shared-cache dataset id for computed community metrics (#756 table). */
export const COMMUNITY_LIVING_CACHE_DATASET = 'neighbourhood-community-living';

export interface NeighbourhoodReadServiceDeps {
  readonly store: Pick<
    NeighbourhoodDataStore,
    | 'schoolsIn'
    | 'amenitiesIn'
    | 'communityAnchor'
    | 'communityMetrics'
    | 'getLotMetrics'
    | 'putLotMetrics'
  >;
  /** From config. */
  readonly lotRadiusM: number;
  /** From config: how long a computed per-address row is reused. */
  readonly lotMetricsTtlMs: number;
  /** #777, from config: categories reported per community (key + label). */
  readonly amenityCategories: readonly { readonly key: string; readonly label: string }[];
  readonly amenitySearchRadiusM: number;
  /** Ascending. */
  readonly amenityCountRadiiM: readonly number[];
  /** Public trees per hectare: [low, high]. */
  readonly treeCoverThresholds: readonly [number, number];
  /** Shared City-data cache (#756); failures fall back to computing. */
  readonly communityCache?: Pick<CityDataCacheStore, 'get' | 'put'>;
  readonly communityMetricsTtlMs: number;
  readonly clock?: () => Date;
  readonly logWarning?: (message: string) => void;
}

export interface NeighbourhoodReadService {
  getLotLivingMetrics(input: {
    readonly addressKey: string;
    readonly lat: number;
    readonly lng: number;
  }): Promise<LotLivingMetrics>;
  /** By City community code ('ALT') or slug ('altadore'). */
  getCommunityLivingMetrics(codeOrSlug: string): Promise<CommunityLivingMetrics>;
}

/** Metres per degree of latitude (close enough for a coarse bounding box). */
const METERS_PER_DEGREE = 111_320;

export function boundingBox(lat: number, lng: number, radiusM: number): BoundingBox {
  const dLat = radiusM / METERS_PER_DEGREE;
  const dLng = radiusM / (METERS_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export function treeCoverLevel(treesPerHa: number, [low, high]: readonly [number, number]): TreeCoverLevel {
  if (treesPerHa < low) return 'low';
  return treesPerHa >= high ? 'high' : 'moderate';
}

function treeCoverOf(data: unknown, thresholds: readonly [number, number]): CommunityTreeCover | null {
  if (typeof data !== 'object' || data === null) return null;
  const { publicTrees, areaHa, treesPerHa } = data as Record<string, unknown>;
  if (typeof publicTrees !== 'number' || typeof areaHa !== 'number' || typeof treesPerHa !== 'number') {
    return null;
  }
  return { publicTrees, areaHa, treesPerHa, level: treeCoverLevel(treesPerHa, thresholds) };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function createNeighbourhoodReadService(
  deps: NeighbourhoodReadServiceDeps,
): NeighbourhoodReadService {
  const {
    store,
    lotRadiusM,
    lotMetricsTtlMs,
    amenityCategories,
    amenitySearchRadiusM,
    amenityCountRadiiM,
    treeCoverThresholds,
    communityCache,
    communityMetricsTtlMs,
    clock = () => new Date(),
    logWarning = (message: string) => console.warn(message),
  } = deps;

  async function computeCommunity(key: string): Promise<CommunityLivingMetrics> {
    const anchor = await store.communityAnchor(key);
    const code = anchor?.communityCode ?? key.toUpperCase();
    const rows = await store.communityMetrics(code);
    const metrics: Record<string, { source: string; data: unknown }> = {};
    for (const row of rows) metrics[row.metric] = { source: row.source, data: row.data };
    if (!anchor) {
      return {
        communityCode: code,
        name: null,
        slug: null,
        searchRadiusM: amenitySearchRadiusM,
        amenities: [],
        treeCover: null,
        dataRefreshedAt: null,
        metrics,
      };
    }

    const origin = { lat: anchor.lat, lon: anchor.lng };
    const nearby = await store.amenitiesIn(boundingBox(anchor.lat, anchor.lng, amenitySearchRadiusM));
    const byCategory = new Map<string, Array<{ name: string; distanceM: number }>>();
    for (const a of nearby) {
      const distanceM = Math.round(haversineMeters(origin, { lat: a.lat, lon: a.lng }));
      if (distanceM > amenitySearchRadiusM) continue;
      const list = byCategory.get(a.category) ?? [];
      list.push({ name: a.name, distanceM });
      byCategory.set(a.category, list);
    }
    const amenities = amenityCategories.map(({ key: category, label }): CommunityAmenityMetric => {
      const list = (byCategory.get(category) ?? []).sort(
        (a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name),
      );
      return {
        category,
        label,
        nearest: list[0] ?? null,
        counts: amenityCountRadiiM.map((radiusM) => ({
          radiusM,
          count: list.filter((a) => a.distanceM <= radiusM).length,
        })),
      };
    });
    const slug = (anchor.data as { slug?: unknown } | null)?.slug;
    return {
      communityCode: code,
      name: anchor.name,
      slug: typeof slug === 'string' ? slug : null,
      searchRadiusM: amenitySearchRadiusM,
      amenities,
      treeCover: treeCoverOf(anchor.data, treeCoverThresholds),
      dataRefreshedAt: anchor.refreshedAt.toISOString(),
      metrics,
    };
  }

  return {
    async getLotLivingMetrics({ addressKey, lat, lng }): Promise<LotLivingMetrics> {
      const now = clock();
      const cached = (await store.getLotMetrics(addressKey, now)) as LotLivingMetrics | undefined;
      if (cached) return cached;

      const box = boundingBox(lat, lng, lotRadiusM);
      const origin = { lat, lon: lng };
      const [schoolRows, amenityRows] = await Promise.all([
        store.schoolsIn(box),
        store.amenitiesIn(box),
      ]);
      const schools = schoolRows
        .map((s) => ({
          id: s.id,
          name: s.name,
          board: s.board,
          grades: s.grades,
          distanceM: Math.round(haversineMeters(origin, { lat: s.lat, lon: s.lng })),
        }))
        .filter((s) => s.distanceM <= lotRadiusM)
        .sort((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name));
      const amenityCounts: Record<string, number> = {};
      for (const a of amenityRows) {
        if (haversineMeters(origin, { lat: a.lat, lon: a.lng }) > lotRadiusM) continue;
        amenityCounts[a.category] = (amenityCounts[a.category] ?? 0) + 1;
      }
      const metrics: LotLivingMetrics = {
        radiusM: lotRadiusM,
        schools,
        amenityCounts,
        computedAt: now.toISOString(),
      };
      await store.putLotMetrics(addressKey, metrics, now, new Date(now.getTime() + lotMetricsTtlMs));
      return metrics;
    },

    async getCommunityLivingMetrics(codeOrSlug): Promise<CommunityLivingMetrics> {
      const key = codeOrSlug.trim().toLowerCase();
      const now = clock();
      if (communityCache) {
        try {
          const cached = await communityCache.get(COMMUNITY_LIVING_CACHE_DATASET, key, now);
          if (cached) return cached as CommunityLivingMetrics;
        } catch (error) {
          logWarning(`neighbourhood-read: community cache read failed (${errorName(error)})`);
        }
      }
      const result = await computeCommunity(key);
      // Unknown communities are not cached (no junk keys from arbitrary slugs).
      const known = result.name !== null || Object.keys(result.metrics).length > 0;
      if (communityCache && known) {
        try {
          await communityCache.put(
            COMMUNITY_LIVING_CACHE_DATASET,
            key,
            result,
            new Date(now.getTime() + communityMetricsTtlMs),
          );
        } catch (error) {
          logWarning(`neighbourhood-read: community cache write failed (${errorName(error)})`);
        }
      }
      return result;
    },
  };
}
