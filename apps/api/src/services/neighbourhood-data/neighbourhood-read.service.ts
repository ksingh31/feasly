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
 */
import { haversineMeters } from '../../lib/geo';
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

export interface CommunityLivingMetrics {
  readonly communityCode: string;
  /** Metric name ('commute', 'reviews') → stored data (absent when none). */
  readonly metrics: Readonly<Record<string, { readonly source: string; readonly data: unknown }>>;
}

export interface NeighbourhoodReadServiceDeps {
  readonly store: Pick<
    NeighbourhoodDataStore,
    'schoolsIn' | 'amenitiesIn' | 'communityMetrics' | 'getLotMetrics' | 'putLotMetrics'
  >;
  /** From config. */
  readonly lotRadiusM: number;
  /** From config: how long a computed per-address row is reused. */
  readonly lotMetricsTtlMs: number;
  readonly clock?: () => Date;
}

export interface NeighbourhoodReadService {
  getLotLivingMetrics(input: {
    readonly addressKey: string;
    readonly lat: number;
    readonly lng: number;
  }): Promise<LotLivingMetrics>;
  getCommunityLivingMetrics(communityCode: string): Promise<CommunityLivingMetrics>;
}

/** Metres per degree of latitude (close enough for a coarse bounding box). */
const METERS_PER_DEGREE = 111_320;

export function boundingBox(lat: number, lng: number, radiusM: number): BoundingBox {
  const dLat = radiusM / METERS_PER_DEGREE;
  const dLng = radiusM / (METERS_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export function createNeighbourhoodReadService(
  deps: NeighbourhoodReadServiceDeps,
): NeighbourhoodReadService {
  const { store, lotRadiusM, lotMetricsTtlMs, clock = () => new Date() } = deps;

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

    async getCommunityLivingMetrics(communityCode): Promise<CommunityLivingMetrics> {
      const code = communityCode.trim().toUpperCase();
      const rows = await store.communityMetrics(code);
      const metrics: Record<string, { source: string; data: unknown }> = {};
      for (const row of rows) metrics[row.metric] = { source: row.source, data: row.data };
      return { communityCode: code, metrics };
    },
  };
}
