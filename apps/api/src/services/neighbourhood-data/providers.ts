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
 * - `free-public` (#774) — school directory merged from City Schools, the
 *   Alberta school authority list and OpenStreetMap (`school-directory.ts`).
 * - `calgary-open-data` — City of Calgary open data (Socrata): Schools (+
 *   authority list, no OSM call), and for amenities one dataset per configured
 *   category (parks, playgrounds, pathways, rec centres, pools, libraries,
 *   off-leash areas — #777) plus per-community public-tree cover.
 * - `straight-line` — straight-line distance from each established community
 *   (#690 rule, Community Points dataset) to a configured destination.
 *   A distance, never a travel time.
 * - `none` — no source chosen yet: the refresh skips it and writes nothing.
 *
 * Records carry public open data only — no personal data.
 */
import type {
  AmenityCategoryConfig,
  AmenitiesImpl,
  CommuteImpl,
  NeighbourhoodDataConfig,
  ReviewsImpl,
  SchoolDesignationImpl,
  SchoolDirectoryImpl,
  SchoolRatingsImpl,
} from '../../config';
import type { SchoolType } from '@feasly/contracts';
import {
  haversineMeters,
  lineRepresentativePoint,
  parcelInteriorPoint,
  polygonAreaM2,
} from '../../lib/geo';
import { toSlug } from '../community-stats/socrata-aggregates';
import { TREE_COVER_CATEGORY } from './categories';
import { buildSchoolDirectory, type OsmElement } from './school-directory';

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
  /** #774: every directory school has a type. */
  readonly schoolType: SchoolType;
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

/** Optional SoQL clauses (#777). */
export interface SocrataQuery {
  readonly select?: string;
  readonly where?: string;
  readonly group?: string;
}

/** Fetches every row of a dataset (one request, capped at `maxRows`). */
export type SocrataRowsFetcher = (
  datasetId: string,
  query?: SocrataQuery,
) => Promise<readonly Record<string, unknown>[]>;

export function createSocrataRowsFetcher(deps: SocrataClientDeps): SocrataRowsFetcher {
  const { socrataBaseUrl, httpTimeoutMs, maxRows } = deps;
  const fetchImpl: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  return async (datasetId, query = {}) => {
    let url = `${socrataBaseUrl}/resource/${encodeURIComponent(datasetId)}.json?$limit=${maxRows}`;
    if (query.select) url += `&$select=${encodeURIComponent(query.select)}`;
    if (query.where) url += `&$where=${encodeURIComponent(query.where)}`;
    if (query.group) url += `&$group=${encodeURIComponent(query.group)}`;
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

/** Fetches OSM elements for an Overpass QL query. */
export type OverpassFetcher = (query: string) => Promise<readonly OsmElement[]>;

export interface OverpassClientDeps {
  readonly overpassUrl: string;
  readonly httpTimeoutMs: number;
  readonly fetchImpl?: FetchLike;
}

export function createOverpassFetcher(deps: OverpassClientDeps): OverpassFetcher {
  const fetchImpl: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  return async (query) => {
    const url = `${deps.overpassUrl}?data=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.httpTimeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'user-agent': 'feasly-neighbourhood-refresh/1.0' },
      });
      if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
      const body = (await res.json()) as { elements?: unknown };
      if (typeof body !== 'object' || body === null || !Array.isArray(body.elements)) {
        throw new Error('Overpass response had no elements array');
      }
      return body.elements.filter(
        (el): el is OsmElement =>
          typeof el === 'object' &&
          el !== null &&
          typeof (el as OsmElement).type === 'string' &&
          typeof (el as OsmElement).id === 'number',
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Overpass QL: every amenity=school in the bbox (south,west,north,east). */
export function osmSchoolsQuery(bbox: string, timeoutS: number): string {
  return `[out:json][timeout:${timeoutS}];nwr["amenity"="school"](${bbox});out center tags;`;
}

export interface SchoolDirectoryProviderDeps {
  readonly fetchRows: SocrataRowsFetcher;
  readonly schoolsDatasetId: string;
  readonly communityBoundariesDatasetId: string;
  readonly dedupeRadiusM: number;
  /** Absent → City + authority list only (no OSM call). */
  readonly osm?: { readonly fetch: OverpassFetcher; readonly query: string };
}

/**
 * #774 school directory: City Schools + Alberta authority list (+ OSM when
 * configured), merged by `buildSchoolDirectory`. Any source failing fails
 * the refresh (the job keeps the previous directory) — a partial merge
 * would silently drop or retype schools.
 */
export function createSchoolDirectoryProvider<TImpl extends 'free-public' | 'calgary-open-data'>(
  implementation: TImpl,
  deps: SchoolDirectoryProviderDeps,
): NeighbourhoodProvider<SchoolRecord, TImpl> {
  return {
    implementation,
    async fetchAll() {
      const [cityRows, boundaries, osmElements] = await Promise.all([
        deps.fetchRows(deps.schoolsDatasetId),
        deps.fetchRows(deps.communityBoundariesDatasetId),
        deps.osm ? deps.osm.fetch(deps.osm.query) : Promise.resolve([] as readonly OsmElement[]),
      ]);
      if (cityRows.length === 0) throw new Error('City Schools dataset returned no rows');
      return buildSchoolDirectory({
        cityRows,
        osmElements,
        boundaries,
        dedupeRadiusM: deps.dedupeRadiusM,
      });
    },
  };
}

/** First GeoJSON geometry value in a row (`point`, `multipolygon`, `the_geom`, ...). */
function geometryOf(row: Record<string, unknown>): { type: string } | null {
  for (const value of Object.values(row)) {
    if (typeof value !== 'object' || value === null) continue;
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string' && Array.isArray((value as { coordinates?: unknown }).coordinates)) {
      return value as { type: string };
    }
  }
  return null;
}

/**
 * One representative point for any row (#777): a Point / lat-lng fields as
 * is, a polygon's interior point, a line's middle vertex.
 */
export function representativePoint(row: Record<string, unknown>): { lat: number; lng: number } | null {
  const point = pointOf(row);
  if (point) return point;
  const geometry = geometryOf(row);
  if (!geometry) return null;
  const p =
    geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'
      ? parcelInteriorPoint(geometry)
      : geometry.type === 'LineString' || geometry.type === 'MultiLineString'
        ? lineRepresentativePoint(geometry)
        : null;
  return p ? { lat: p.lat, lng: p.lon } : null;
}

/** One configured category's rows → amenity records (de-duplicated by id). */
export function mapCategoryRows(
  category: AmenityCategoryConfig,
  rows: readonly Record<string, unknown>[],
): AmenityRecord[] {
  const seen = new Set<string>();
  const out: AmenityRecord[] = [];
  for (const row of rows) {
    const point = representativePoint(row);
    if (!point) continue;
    const name = (category.nameField ? str(row[category.nameField]) : null) ?? category.label;
    const sourceId = category.idField ? str(row[category.idField]) : null;
    // No stable id field: name + rounded location identify a row.
    const externalId = (
      sourceId
        ? `${category.key}|${sourceId}`
        : `${category.key}|${name}|${point.lat.toFixed(5)},${point.lng.toFixed(5)}`
    ).toLowerCase();
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    out.push({
      externalId,
      category: category.key,
      name,
      communityCode: str(row['comm_code']),
      lat: point.lat,
      lng: point.lng,
      data: { address: str(row['address']) ?? str(row['parcel_location']) },
    });
  }
  return out;
}

/** A configured category returned nothing — fail the refresh (keep old data). */
export class EmptyAmenityCategoryError extends Error {
  constructor(category: string) {
    super(`amenity category ${category} returned no usable rows`);
    this.name = 'EmptyAmenityCategoryError';
  }
}

/** #690 rule: residential class + established community structure. */
function isEstablished(
  row: Record<string, unknown>,
  communityClass: string,
  structures: ReadonlySet<string>,
): boolean {
  return (
    str(row['class'])?.toUpperCase() === communityClass.toUpperCase() &&
    structures.has(str(row['comm_structure'])?.toUpperCase() ?? '')
  );
}

export interface CalgaryAmenitiesDeps {
  readonly fetchRows: SocrataRowsFetcher;
  readonly categories: readonly AmenityCategoryConfig[];
  readonly communityPointsDatasetId: string;
  readonly communityBoundariesDatasetId: string;
  readonly publicTreesDatasetId: string;
  readonly communityClass: string;
  readonly communityStructures: readonly string[];
}

/**
 * Per established community: City public trees per hectare of community
 * area, as one `tree-cover` record located at the community centre. It is a
 * count of City-maintained trees, not a measured canopy.
 */
async function fetchTreeCover(deps: CalgaryAmenitiesDeps): Promise<AmenityRecord[]> {
  const structures = new Set(deps.communityStructures.map((s) => s.toUpperCase()));
  const [points, boundaries, treeCounts] = await Promise.all([
    deps.fetchRows(deps.communityPointsDatasetId),
    deps.fetchRows(deps.communityBoundariesDatasetId),
    deps.fetchRows(deps.publicTreesDatasetId, {
      select: 'comm_code, count(*) AS trees',
      group: 'comm_code',
    }),
  ]);
  const areaByCode = new Map<string, number>();
  for (const row of boundaries) {
    const code = str(row['comm_code'])?.toUpperCase();
    const area = polygonAreaM2(geometryOf(row));
    if (code && area > 0) areaByCode.set(code, area);
  }
  const treesByCode = new Map<string, number>();
  for (const row of treeCounts) {
    const code = str(row['comm_code'])?.toUpperCase();
    const trees = num(row['trees']);
    if (code && trees !== null) treesByCode.set(code, trees);
  }
  const out: AmenityRecord[] = [];
  for (const row of points) {
    const code = str(row['comm_code'])?.toUpperCase();
    const name = str(row['name']);
    if (!code || !name || !isEstablished(row, deps.communityClass, structures)) continue;
    const point = pointOf(row);
    const areaM2 = areaByCode.get(code);
    if (!point || !areaM2) continue;
    const publicTrees = treesByCode.get(code) ?? 0;
    const areaHa = areaM2 / 10_000;
    out.push({
      externalId: `${TREE_COVER_CATEGORY}|${code}`.toLowerCase(),
      category: TREE_COVER_CATEGORY,
      name,
      communityCode: code,
      lat: point.lat,
      lng: point.lng,
      data: {
        slug: toSlug(name),
        publicTrees,
        areaHa: Math.round(areaHa * 10) / 10,
        treesPerHa: Math.round((publicTrees / areaHa) * 10) / 10,
      },
    });
  }
  return out;
}

/**
 * City of Calgary open data → amenities (#777): one dataset (+ optional SoQL
 * filter) per configured category, plus per-community public-tree cover.
 * Any category coming back empty fails the whole refresh, so a broken
 * dataset never prunes that category's existing rows.
 */
export function createCalgaryAmenitiesProvider(deps: CalgaryAmenitiesDeps): AmenitiesProvider {
  return {
    implementation: 'calgary-open-data',
    async fetchAll() {
      const out: AmenityRecord[] = [];
      for (const category of deps.categories) {
        const rows = await deps.fetchRows(
          category.datasetId,
          category.where ? { where: category.where } : {},
        );
        const records = mapCategoryRows(category, rows);
        if (records.length === 0) throw new EmptyAmenityCategoryError(category.key);
        out.push(...records);
      }
      const treeCover = await fetchTreeCover(deps);
      if (treeCover.length === 0) throw new EmptyAmenityCategoryError(TREE_COVER_CATEGORY);
      out.push(...treeCover);
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
  const schoolDeps: SchoolDirectoryProviderDeps = {
    fetchRows,
    schoolsDatasetId: config.schoolsDatasetId,
    communityBoundariesDatasetId: config.communityBoundariesDatasetId,
    dedupeRadiusM: config.schoolDedupeRadiusM,
  };
  const overpass = createOverpassFetcher({
    overpassUrl: config.osmOverpassUrl,
    httpTimeoutMs: config.osmHttpTimeoutMs,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return {
    schoolDirectory:
      p.schoolDirectory === 'free-public'
        ? createSchoolDirectoryProvider('free-public', {
            ...schoolDeps,
            osm: {
              fetch: overpass,
              query: osmSchoolsQuery(config.osmBbox, Math.ceil(config.osmHttpTimeoutMs / 1000)),
            },
          })
        : p.schoolDirectory === 'calgary-open-data'
          ? createSchoolDirectoryProvider('calgary-open-data', schoolDeps)
          : noneProvider(),
    schoolDesignation: noneProvider(),
    schoolRatings: noneProvider(),
    reviews: noneProvider(),
    amenities:
      p.amenities === 'calgary-open-data'
        ? createCalgaryAmenitiesProvider({
            fetchRows,
            categories: config.amenityCategories,
            communityPointsDatasetId: config.communityPointsDatasetId,
            communityBoundariesDatasetId: config.communityBoundariesDatasetId,
            publicTreesDatasetId: config.publicTreesDatasetId,
            communityClass: config.communityClass,
            communityStructures: config.communityStructures,
          })
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
