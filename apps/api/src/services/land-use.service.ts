/**
 * Current land-use district lookup (#686).
 *
 * The assessment roll's `land_use_designation` reflects a past condition
 * date and still carries pre-repeal pairs (e.g. "R-C2,R-CG"). "What can be
 * built" needs the lot's CURRENT district, which the City publishes as the
 * Land Use Districts polygon dataset (Calgary: Socrata `qe6k-p9nh`, updated
 * weekly). A provider resolves a point inside the parcel to a district.
 *
 * - The provider is chosen per city by config (`LAND_USE_PROVIDER`), so
 *   another city can plug in its own source; 'assessment-roll' disables it.
 * - Transport failures and timeouts THROW; the caller (property service)
 *   falls back to the roll value — a property lookup never fails because
 *   the district lookup failed.
 * - No hit (point outside every polygon) resolves to null.
 * - Only public City data; nothing is logged here.
 */
import type { LandUseConfig } from '../config';
import type { LonLat } from '../lib/geo';

/** A district resolved from the current Land Use Districts map. */
export interface LandUseDistrict {
  /** District code, e.g. 'R-C2', 'DC'. */
  readonly district: string;
  /** City description; empty when the source has none. */
  readonly description: string;
  /** Direct Control bylaw number (e.g. '48Z84'), DC districts only. */
  readonly dcBylaw?: string;
}

export interface LandUseProvider {
  /**
   * District at a point inside the parcel.
   * @returns null when no district polygon contains the point.
   * @throws on transport failure, non-2xx, or timeout.
   */
  resolve(point: LonLat): Promise<LandUseDistrict | null>;
}

/** Raw row from the Calgary Land Use Districts dataset. */
interface LandUseRow {
  readonly lu_code?: string;
  readonly description?: string;
  readonly dc_bylaw?: string;
}

const LAND_USE_FIELDS = ['lu_code', 'description', 'dc_bylaw'];

/** Coordinates go into SoQL as numbers only — never interpolate raw input. */
function wktPoint(point: LonLat): string {
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) {
    throw new Error('land-use: non-finite point');
  }
  return `POINT(${point.lon} ${point.lat})`;
}

/**
 * Picks one district from the rows intersecting the point. Polygons should
 * not overlap; if a point sits exactly on a shared edge, the choice is made
 * deterministic by taking the lexically smallest code.
 */
function toDistrict(body: unknown): LandUseDistrict | null {
  if (!Array.isArray(body)) return null;
  const hits: LandUseDistrict[] = [];
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as LandUseRow;
    const district = typeof row.lu_code === 'string' ? row.lu_code.trim() : '';
    if (!district) continue;
    const dcBylaw = typeof row.dc_bylaw === 'string' ? row.dc_bylaw.trim() : '';
    hits.push({
      district,
      description: typeof row.description === 'string' ? row.description.trim() : '',
      ...(dcBylaw ? { dcBylaw } : {}),
    });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => (a.district < b.district ? -1 : a.district > b.district ? 1 : 0));
  return hits[0];
}

/** Calgary implementation: SoQL `intersects()` against Land Use Districts. */
export function createCalgaryLandUseProvider(config: LandUseConfig): LandUseProvider {
  const resourceUrl = `${config.socrataBaseUrl}/resource/${config.datasetId}.json`;
  return {
    async resolve(point: LonLat): Promise<LandUseDistrict | null> {
      const params = new URLSearchParams({
        $select: LAND_USE_FIELDS.join(','),
        $where: `intersects(multipolygon,'${wktPoint(point)}')`,
        $limit: '5',
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
      try {
        const res = await fetch(`${resourceUrl}?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`land-use: HTTP ${res.status}`);
        return toDistrict((await res.json()) as unknown);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Provider for a city's config; undefined when the city uses the assessment
 * roll only (no current-district source).
 */
export function createLandUseProvider(config: LandUseConfig): LandUseProvider | undefined {
  switch (config.provider) {
    case 'calgary-land-use-districts':
      return createCalgaryLandUseProvider(config);
    case 'assessment-roll':
      return undefined;
  }
}
