/**
 * Neighbourhood data providers (#773, Community Match epic).
 *
 * Every outside neighbourhood source sits behind one of six provider
 * interfaces. Each has a free implementation today; `config.neighbourhoodData
 * .providers` picks which one runs, so a paid source can replace a free one
 * with a config change and no UI change.
 *
 * Providers are called ONLY by the monthly refresh job
 * (`neighbourhood-refresh.service.ts`). Request paths read our tables through
 * `neighbourhood-read.service.ts`, which has no access to providers
 * (test/neighbourhood-data.read.test.ts asserts zero provider calls).
 *
 * Free implementations:
 * - `calgary-open-data` — City of Calgary open data (Socrata): Schools and
 *   Community Services datasets.
 * - `straight-line` — straight-line distance from each established community
 *   (#690 rule, Community Points dataset) to a configured destination.
 *   A distance, never a travel time.
 * - `none` — no source chosen yet: the refresh skips it and writes nothing.
 *
 * Records carry public open data only — no personal data.
 */
import type {
  AmenitiesImpl,
  CommuteImpl,
  NeighbourhoodDataConfig,
  ReviewsImpl,
  SchoolDesignationImpl,
  SchoolDirectoryImpl,
  SchoolRatingsImpl,
} from '../../config';
import { haversineMeters } from '../../lib/geo';

/** Provider interface keys — also the admin path segment and state key. */
export const NEIGHBOURHOOD_PROVIDER_NAMES = [
  'school-directory',
  'school-designation',
  'school-ratings',
  'reviews',
  'amenities',
  'commute',
] as const;

export type NeighbourhoodProviderName = (typeof NEIGHBOURHOOD_PROVIDER_NAMES)[number];

export function isNeighbourhoodProviderName(value: unknown): value is NeighbourhoodProviderName {
  return (
    typeof value === 'string' &&
    (NEIGHBOURHOOD_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

/** Fields every provider record carries. */
export interface NeighbourhoodRecordBase {
  /** Stable id within the source. */
  readonly externalId: string;
  readonly communityCode?: string | null;
  readonly lat?: number | null;
  readonly lng?: number | null;
  /** Remaining public source fields. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SchoolRecord extends NeighbourhoodRecordBase {
  readonly name: string;
  readonly board: string | null;
  readonly grades: string | null;
}

export interface SchoolDesignationRecord extends NeighbourhoodRecordBase {
  readonly schoolRef: string | null;
  readonly gradeBand: string | null;
}

export interface SchoolRatingRecord extends NeighbourhoodRecordBase {
  readonly schoolRef: string | null;
  readonly rating: number | null;
  readonly period: string | null;
}

export interface AmenityRecord extends NeighbourhoodRecordBase {
  readonly category: string;
  readonly name: string;
}

/** Per-community metric (commute, reviews). */
export interface CommunityMetricRecord extends NeighbourhoodRecordBase {
  readonly communityCode: string;
}

/**
 * A provider returns a full snapshot of its source. Throwing (or, for a real
 * source, returning nothing) is a failed refresh: the job keeps the data it
 * already has.
 */
export interface NeighbourhoodProvider<TRecord, TImpl extends string = string> {
  /** Implementation name, e.g. 'calgary-open-data' — also the row `source`. */
  readonly implementation: TImpl;
  fetchAll(): Promise<readonly TRecord[]>;
}

export type SchoolDirectoryProvider = NeighbourhoodProvider<SchoolRecord, SchoolDirectoryImpl>;
export type SchoolDesignationProvider = NeighbourhoodProvider<
  SchoolDesignationRecord,
  SchoolDesignationImpl
>;
export type SchoolRatingsProvider = NeighbourhoodProvider<SchoolRatingRecord, SchoolRatingsImpl>;
export type ReviewsProvider = NeighbourhoodProvider<CommunityMetricRecord, ReviewsImpl>;
export type AmenitiesProvider = NeighbourhoodProvider<AmenityRecord, AmenitiesImpl>;
export type CommuteProvider = NeighbourhoodProvider<CommunityMetricRecord, CommuteImpl>;

export interface NeighbourhoodProviders {
  readonly schoolDirectory: SchoolDirectoryProvider;
  readonly schoolDesignation: SchoolDesignationProvider;
  readonly schoolRatings: SchoolRatingsProvider;
  readonly reviews: ReviewsProvider;
  readonly amenities: AmenitiesProvider;
  readonly commute: CommuteProvider;
}

/** Implementation name that means "no source chosen": skipped, no writes. */
export const NO_PROVIDER = 'none';

function noneProvider<TRecord>(): NeighbourhoodProvider<TRecord, 'none'> {
  return { implementation: NO_PROVIDER, fetchAll: async () => [] };
}

// ── Socrata transport ────────────────────────────────────────────────────

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SocrataClientDeps {
  readonly socrataBaseUrl: string;
  readonly httpTimeoutMs: number;
  readonly maxRows: number;
  readonly fetchImpl?: FetchLike;
}

/** Fetches every row of a dataset (one request, capped at `maxRows`). */
export type SocrataRowsFetcher = (datasetId: string) => Promise<readonly Record<string, unknown>[]>;

export function createSocrataRowsFetcher(deps: SocrataClientDeps): SocrataRowsFetcher {
  const { socrataBaseUrl, httpTimeoutMs, maxRows } = deps;
  const fetchImpl: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  return async (datasetId) => {
    const url = `${socrataBaseUrl}/resource/${encodeURIComponent(datasetId)}.json?$limit=${maxRows}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'user-agent': 'feasly-neighbourhood-refresh/1.0' },
      });
      if (!res.ok) throw new Error(`Socrata request failed: ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error('Socrata response was not an array');
      return body.filter(
        (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Row parsing helpers ──────────────────────────────────────────────────

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** GeoJSON point `{ coordinates: [lng, lat] }` or separate lat/lng fields. */
function pointOf(row: Record<string, unknown>): { lat: number; lng: number } | null {
  const point = row['point'];
  if (typeof point === 'object' && point !== null) {
    const coords = (point as { coordinates?: unknown }).coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      const lng = num(coords[0]);
      const lat = num(coords[1]);
      if (lat !== null && lng !== null) return { lat, lng };
    }
  }
  const lat = num(row['latitude']);
  const lng = num(row['longitude']);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

// ── Free implementations ─────────────────────────────────────────────────

/** City of Calgary "Schools" dataset → school directory. */
export function createCalgarySchoolDirectoryProvider(
  fetchRows: SocrataRowsFetcher,
  datasetId: string,
): SchoolDirectoryProvider {
  return {
    implementation: 'calgary-open-data',
    async fetchAll() {
      const rows = await fetchRows(datasetId);
      const out: SchoolRecord[] = [];
      for (const row of rows) {
        const externalId = str(row['global_id']);
        const name = str(row['name']);
        if (!externalId || !name) continue;
        const point = pointOf(row);
        out.push({
          externalId,
          name,
          board: str(row['board']),
          grades: str(row['grades']),
          lat: point?.lat ?? null,
          lng: point?.lng ?? null,
          data: {
            address: str(row['address_ab']),
            postalCode: str(row['postal_cod']),
            elementary: row['elem'] === 'Y',
            juniorHigh: row['junior_h'] === 'Y',
            seniorHigh: row['senior_h'] === 'Y',
            postSecondary: row['postsecond'] === 'Y',
          },
        });
      }
      return out;
    },
  };
}

/** City of Calgary "Community Services" dataset → amenities. */
export function createCalgaryAmenitiesProvider(
  fetchRows: SocrataRowsFetcher,
  datasetId: string,
): AmenitiesProvider {
  return {
    implementation: 'calgary-open-data',
    async fetchAll() {
      const rows = await fetchRows(datasetId);
      const seen = new Set<string>();
      const out: AmenityRecord[] = [];
      for (const row of rows) {
        const category = str(row['type']);
        const name = str(row['name']);
        if (!category || !name) continue;
        const address = str(row['address']);
        // The dataset has no stable id: type + name + address identify a row.
        const externalId = `${category}|${name}|${address ?? ''}`.toLowerCase();
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        const point = pointOf(row);
        out.push({
          externalId,
          category,
          name,
          communityCode: str(row['comm_code']),
          lat: point?.lat ?? null,
          lng: point?.lng ?? null,
          data: { address },
        });
      }
      return out;
    },
  };
}

export interface StraightLineCommuteDeps {
  readonly fetchRows: SocrataRowsFetcher;
  readonly communityPointsDatasetId: string;
  readonly communityClass: string;
  readonly communityStructures: readonly string[];
  readonly destination: { readonly name: string; readonly lat: number; readonly lng: number };
}

/**
 * Straight-line distance from each established community's centre (City
 * "Community Points") to the configured destination. Established infill
 * communities only (#690 rule: residential + configured structures).
 */
export function createStraightLineCommuteProvider(deps: StraightLineCommuteDeps): CommuteProvider {
  const structures = new Set(deps.communityStructures.map((s) => s.toUpperCase()));
  return {
    implementation: 'straight-line',
    async fetchAll() {
      const rows = await deps.fetchRows(deps.communityPointsDatasetId);
      const out: CommunityMetricRecord[] = [];
      for (const row of rows) {
        const code = str(row['comm_code']);
        if (!code) continue;
        if (str(row['class'])?.toUpperCase() !== deps.communityClass.toUpperCase()) continue;
        if (!structures.has(str(row['comm_structure'])?.toUpperCase() ?? '')) continue;
        const point = pointOf(row);
        if (!point) continue;
        const meters = haversineMeters(
          { lat: point.lat, lon: point.lng },
          { lat: deps.destination.lat, lon: deps.destination.lng },
        );
        out.push({
          externalId: code,
          communityCode: code,
          lat: point.lat,
          lng: point.lng,
          data: {
            communityName: str(row['name']),
            destination: deps.destination.name,
            straightLineKm: Math.round(meters / 100) / 10,
          },
        });
      }
      return out;
    },
  };
}

export interface NeighbourhoodProviderFactoryDeps {
  /** Injectable transport (tests); defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
}

/**
 * Builds the six providers from config. The ONLY place an implementation is
 * chosen — switching one is a config change (test/neighbourhood-data
 * .providers.test.ts).
 */
export function createNeighbourhoodProviders(
  config: NeighbourhoodDataConfig,
  deps: NeighbourhoodProviderFactoryDeps = {},
): NeighbourhoodProviders {
  const fetchRows = createSocrataRowsFetcher({
    socrataBaseUrl: config.socrataBaseUrl,
    httpTimeoutMs: config.httpTimeoutMs,
    maxRows: config.maxRows,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const p = config.providers;
  return {
    schoolDirectory:
      p.schoolDirectory === 'calgary-open-data'
        ? createCalgarySchoolDirectoryProvider(fetchRows, config.schoolsDatasetId)
        : noneProvider(),
    schoolDesignation: noneProvider(),
    schoolRatings: noneProvider(),
    reviews: noneProvider(),
    amenities:
      p.amenities === 'calgary-open-data'
        ? createCalgaryAmenitiesProvider(fetchRows, config.amenitiesDatasetId)
        : noneProvider(),
    commute:
      p.commute === 'straight-line'
        ? createStraightLineCommuteProvider({
            fetchRows,
            communityPointsDatasetId: config.communityPointsDatasetId,
            communityClass: config.communityClass,
            communityStructures: config.communityStructures,
            destination: config.commuteDestination,
          })
        : noneProvider(),
  };
}
