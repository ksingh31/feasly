/**
 * Property lookup service — City of Calgary Socrata backend (api-mcp/02).
 *
 * Server-side port of the frontend's CalgaryAssessmentService: address
 * autocomplete and property records straight from the City's open-data
 * Socrata API (dataset 4bsw-nn7w) — free, no key required. The client never
 * touches the City dataset directly; it calls the API, which wraps it.
 *
 * All fields returned are public City data (PropertyRecord contract).
 *
 * - Anonymous Socrata requests are rate-limited per IP, so responses are
 *   cached in-memory (TTL from config).
 * - Parcels can share an address (condos, multi-parcel lots): the record
 *   choice is deterministic — the row with the highest assessed value.
 * - Transport failures and timeouts throw DEPENDENCY_UNAVAILABLE (503,
 *   retryable); unknown addresses throw NOT_FOUND (404).
 * - No PII in logs: addresses are public City data, but query strings are
 *   never logged — only error classes and row counts.
 * - #686: `zoning` carries the parcel's CURRENT district from the city's
 *   LandUseProvider (Calgary: Land Use Districts map), resolved at a point
 *   inside the parcel polygon and cached for `landUse.cacheTtlMs`. On
 *   timeout, error, or no polygon hit it falls back to the roll's
 *   designation (`landUse.source = 'assessment-roll'`) — a district failure
 *   never fails the lookup.
 */
import type {
  AutocompleteResponse,
  AutocompleteSuggestion,
  PropertyLandUse,
  PropertyRecord,
} from '@feasly/contracts';
import { HttpError, ErrorCodes } from '../middleware/errors';
import { detectCoverageSignal } from '../lib/coverage';
import { normalizeAddressQuery, type NormalizedAddressQuery } from '../lib/address-query';
import { parcelInteriorPoint, type LonLat } from '../lib/geo';
import type { PropertyDataConfig } from '../config';
import type { LandUseDistrict, LandUseProvider } from './land-use.service';

/** Raw Socrata row from the "Current Year Property Assessments (Parcel)" dataset. */
interface AssessmentRow {
  readonly roll_year?: string | number;
  readonly address?: string;
  readonly assessed_value?: string | number;
  readonly assessment_class?: string;
  readonly assessment_class_description?: string;
  readonly comm_name?: string;
  readonly year_of_construction?: string | number;
  readonly land_use_designation?: string;
  readonly land_size_sf?: string | number;
  readonly mod_date?: string;
  /** Parcel polygon (GeoJSON MultiPolygon). */
  readonly multipolygon?: unknown;
}

/** Columns read for autocomplete (kept narrow: less over the wire). */
const SEARCH_FIELDS = ['address', 'comm_name'];
/** Columns read for a full property record. */
const DETAIL_FIELDS = [
  'roll_year',
  'address',
  'assessed_value',
  'assessment_class',
  'assessment_class_description',
  'comm_name',
  'year_of_construction',
  'land_use_designation',
  'land_size_sf',
  'mod_date',
  'multipolygon',
];

/** Minimum query length, mirroring the frontend autocomplete gate. */
const MIN_QUERY_CHARS = 3;

/** Trailing quadrant token stays uppercase: "16 AVE NW" -> "16 AV NW". */
const QUADRANT = /^(NW|NE|SW|SE)$/i;

interface CacheEntry<T> {
  readonly expires: number;
  readonly value: T;
}

export interface PropertyService {
  /**
   * Address autocomplete suggestions for a partial query.
   * Short queries (< 3 chars) resolve to an empty list.
   */
  autocomplete(query: string): Promise<AutocompleteResponse>;
  /**
   * Full property record for an exact address key.
   * @throws HttpError 404 NOT_FOUND when the City has no record.
   * @throws HttpError 503 DEPENDENCY_UNAVAILABLE when the City API is down.
   */
  getProperty(addressKey: string, options?: GetPropertyOptions): Promise<PropertyRecord>;
}

export interface GetPropertyOptions {
  /** Request correlation ID — included in the district-fallback warning. */
  readonly correlationId?: string;
}

/** Coerces a Socrata numeric-ish value; null when missing or malformed. */
function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Narrows an unknown JSON value to an AssessmentRow shape. */
function asRow(value: unknown): AssessmentRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as AssessmentRow;
}

/**
 * True when the City classifies the parcel non-residential
 * (commercial/industrial). The `assessment_class` code is authoritative
 * ('NR'); the description is a fallback for rows that carry it without the
 * code. Deliberately conservative — unknown classes read as residential so
 * a classification vocabulary change can never wrongly block a homeowner.
 */
function isNonResidentialRow(row: AssessmentRow): boolean {
  if (row.assessment_class?.trim().toUpperCase() === 'NR') return true;
  const description = row.assessment_class_description?.toLowerCase() ?? '';
  return (
    description.includes('non-residential') || description.includes('non residential')
  );
}

/** Wraps a value as a SoQL string literal, escaping embedded quotes. */
function soqlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Dataset addresses are uppercase ("918 16 AV NW"); display title-cased. */
function formatAddress(raw: string): string {
  const words = raw.trim().split(/\s+/);
  return words
    .map((word, index) =>
      index === words.length - 1 && QUADRANT.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}

/**
 * Miss reason for the `lookup.miss` metric (reno/05, #701). Only the
 * normalized address key is ever passed to the metric sink — never raw user
 * input. Autocomplete misses carry what the query looked like
 * (`postal_code` → the FSA only, `no_house_number`, `unit`) so the team can
 * see what people type.
 */
export type LookupMissReason =
  | 'out_of_coverage'
  | 'not_found'
  | 'postal_code'
  | 'no_house_number'
  | 'unit';

/** Autocomplete miss reason (and metric key) for a normalized query. */
function autocompleteMiss(parsed: NormalizedAddressQuery): {
  reason: LookupMissReason;
  key: string;
} {
  switch (parsed.kind) {
    case 'postal_code':
      return { reason: 'postal_code', key: parsed.postalFsa ?? '' };
    case 'unit':
      return { reason: 'unit', key: parsed.search };
    case 'no_house_number':
      return { reason: 'no_house_number', key: parsed.search };
    default:
      return { reason: 'not_found', key: parsed.search };
  }
}

/**
 * #701 fallback predicate: house number + street name as whole words,
 * anywhere in the City key ("1234 17 " finds "201 1234 17 AV SW"). LIKE
 * wildcards cannot reach it — normalization keeps only [A-Z0-9 #'-] — and
 * quotes are escaped by soqlString.
 */
function fallbackPredicate(houseNumber: string, streetName: string): string {
  const needle = `${houseNumber} ${streetName} `;
  return (
    `starts_with(upper(address),${soqlString(needle)})` +
    ` OR upper(address) like ${soqlString(`% ${needle}%`)}`
  );
}

export interface PropertyServiceDeps {
  /**
   * Called once per property/autocomplete miss with the miss reason.
   * Optional — the service works without a metric sink (tests, local dev).
   */
  readonly onLookupMiss?: (reason: LookupMissReason, addressKey: string) => void;
  /**
   * #686: current land-use district source for this city, and how long a
   * resolved district is reused. Absent → `zoning` is the roll value
   * (`landUse.source = 'assessment-roll'`).
   */
  readonly landUse?: {
    readonly provider: LandUseProvider;
    readonly cacheTtlMs: number;
  };
  /** Warning sink for the district fallback (default console.warn). */
  readonly logWarning?: (message: string) => void;
}

/**
 * Maps a Socrata miss onto the reno/05 error contract:
 * - explicit out-of-coverage signal → 404 OUT_OF_COVERAGE ("We only support
 *   Calgary right now.")
 * - otherwise → 404 ADDRESS_NOT_FOUND ("We couldn't find that address…").
 * Emits the `lookup.miss` metric with the reason, then throws.
 */
function miss(
  query: string,
  addressKey: string,
  onLookupMiss?: PropertyServiceDeps['onLookupMiss'],
): never {
  const signal = detectCoverageSignal(query);
  if (signal === 'out-of-coverage') {
    onLookupMiss?.('out_of_coverage', addressKey);
    throw new HttpError(
      404,
      ErrorCodes.OUT_OF_COVERAGE,
      'We only support Calgary right now.',
      false,
    );
  }
  onLookupMiss?.('not_found', addressKey);
  throw new HttpError(
    404,
    ErrorCodes.ADDRESS_NOT_FOUND,
    "We couldn't find that address. Check the spelling or try a nearby address.",
    false,
  );
}

function cityUnavailable(): HttpError {
  return new HttpError(
    503,
    ErrorCodes.DEPENDENCY_UNAVAILABLE,
    'City property data is temporarily unavailable. Please try again.',
  );
}

/** Maps one verified Socrata row onto the PropertyRecord contract. */
function toPropertyRecord(row: AssessmentRow): PropertyRecord {
  const address = (row.address ?? '').trim();
  const assessedValue = toNumber(row.assessed_value) ?? 0;
  const rollYear = toNumber(row.roll_year);
  // Fallback kept for existing contract consumers (expand phase, #622);
  // `assessmentYearInferred` tells them the year was not read from the City.
  const assessmentYear = rollYear ?? new Date().getFullYear();
  const modDate = row.mod_date?.split('T')[0] ?? '';
  return {
    addressKey: address,
    address: `${formatAddress(address)}, Calgary, AB`,
    community: row.comm_name?.trim() || 'Calgary',
    lotSqft: Math.round(toNumber(row.land_size_sf) ?? 0),
    zoning: row.land_use_designation?.trim() ?? '',
    assessedValue: Math.round(assessedValue),
    assessmentYear,
    assessmentYearInferred: rollYear === null,
    yearBuilt: toNumber(row.year_of_construction),
    assessmentClass: row.assessment_class?.trim() ?? '',
    isNonResidential: isNonResidentialRow(row),
    dataAsOf: modDate || new Date().toISOString().split('T')[0],
    stale: assessmentYear < new Date().getFullYear(),
  };
}

/** Roll record plus the point used for the district lookup (cached together). */
interface RollEntry {
  readonly record: PropertyRecord;
  readonly point: LonLat | null;
}

/** A district check result: the district, or null for "no polygon hit". */
interface DistrictCheck {
  readonly district: LandUseDistrict | null;
  readonly checkedOn: string;
}

/** Fallback: the roll's designation, flagged as such. */
function rollLandUse(record: PropertyRecord): PropertyLandUse | undefined {
  if (!record.zoning) return undefined;
  return {
    district: record.zoning,
    description: '',
    source: 'assessment-roll',
    asOf: record.dataAsOf,
  };
}

/** Error class only — never the message (it may carry the request URL). */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createPropertyService(
  config: PropertyDataConfig,
  deps: PropertyServiceDeps = {},
): PropertyService {
  const resourceUrl = `${config.socrataBaseUrl}/resource/${config.datasetId}.json`;
  const searchCache = new Map<string, CacheEntry<AutocompleteResponse>>();
  const propertyCache = new Map<string, CacheEntry<RollEntry>>();
  const districtCache = new Map<string, CacheEntry<DistrictCheck>>();
  const logWarning = deps.logWarning ?? ((message: string) => console.warn(message));

  /**
   * Applies the current district to a roll record. Resolved districts and
   * "no hit" answers are cached for the land-use TTL; failures are not
   * cached (the next lookup retries) and fall back to the roll value.
   */
  async function withLandUse(
    key: string,
    entry: RollEntry,
    options: GetPropertyOptions,
  ): Promise<PropertyRecord> {
    const fallback = (): PropertyRecord => {
      const landUse = rollLandUse(entry.record);
      return landUse ? { ...entry.record, landUse } : entry.record;
    };
    const landUseDeps = deps.landUse;
    if (!landUseDeps || !entry.point) return fallback();

    let check = cached(districtCache, key);
    if (!check) {
      try {
        const district = await landUseDeps.provider.resolve(entry.point);
        check = { district, checkedOn: new Date().toISOString().split('T')[0] };
        districtCache.set(key, {
          expires: Date.now() + landUseDeps.cacheTtlMs,
          value: check,
        });
      } catch (error) {
        logWarning(
          `[property] land-use district lookup failed (${errorClass(error)}); ` +
            `using assessment-roll designation. correlationId=${options.correlationId ?? 'none'}`,
        );
        return fallback();
      }
    }
    if (!check.district) return fallback();
    const { district, description, dcBylaw } = check.district;
    return {
      ...entry.record,
      zoning: district,
      landUse: {
        district,
        description,
        source: 'land-use-districts',
        asOf: check.checkedOn,
        ...(dcBylaw ? { dcBylaw } : {}),
      },
    };
  }

  function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function store<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, { expires: Date.now() + config.cacheTtlMs, value });
  }

  async function fetchRows(params: URLSearchParams): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const res = await fetch(`${resourceUrl}?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw cityUnavailable();
      return (await res.json()) as unknown;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw cityUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  function toSuggestions(body: unknown): AutocompleteSuggestion[] {
    if (!Array.isArray(body)) return [];
    const seen = new Set<string>();
    const suggestions: AutocompleteSuggestion[] = [];
    for (const item of body) {
      const row = asRow(item);
      const raw = row?.address?.trim() ?? '';
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      suggestions.push({
        addressKey: raw,
        address: `${formatAddress(raw)}, Calgary, AB`,
        community: row?.comm_name?.trim() || 'Calgary',
      });
      if (suggestions.length >= config.suggestionLimit) break;
    }
    return suggestions;
  }

  /**
   * Picks one record for an exact address. Parcels can share an address
   * (condos, multi-parcel lots), so the choice is deterministic: the row
   * with the highest assessed value. Rows without a parseable address or
   * assessed value are skipped; none usable means a reno/05 miss
   * (OUT_OF_COVERAGE vs ADDRESS_NOT_FOUND by coverage signal).
   */
  function toProperty(key: string, body: unknown): RollEntry {
    const rows = Array.isArray(body) ? body : [];
    let best: AssessmentRow | undefined;
    let bestValue = -1;
    for (const item of rows) {
      const row = asRow(item);
      const value = toNumber(row?.assessed_value);
      if (row?.address?.trim() === key && value !== null && value > bestValue) {
        best = row;
        bestValue = value;
      }
    }
    if (!best || bestValue < 0) miss(key, key, deps.onLookupMiss);
    return { record: toPropertyRecord(best), point: parcelInteriorPoint(best.multipolygon) };
  }

  return {
    async autocomplete(query: string): Promise<AutocompleteResponse> {
      const parsed = normalizeAddressQuery(query);
      const q = parsed.search;
      // Reno/05: an explicit out-of-coverage query never hits Socrata — the
      // Calgary-only message is the answer, not an empty suggestion list.
      if (detectCoverageSignal(query) === 'out-of-coverage') {
        miss(query, q || (parsed.postalFsa ?? ''), deps.onLookupMiss);
      }
      // #701: a Calgary postal code alone can never match (the dataset has no
      // postal column) — answer empty without a City request.
      if (parsed.kind === 'postal_code') {
        const cacheKey = `postal:${parsed.postalFsa ?? ''}`;
        const hit = cached(searchCache, cacheKey);
        if (hit) return hit;
        const empty: AutocompleteResponse = { suggestions: [] };
        store(searchCache, cacheKey, empty);
        const { reason, key } = autocompleteMiss(parsed);
        deps.onLookupMiss?.(reason, key);
        return empty;
      }
      if (q.length < MIN_QUERY_CHARS) return { suggestions: [] };
      const hit = cached(searchCache, q);
      if (hit) return hit;

      const search = (where: string): Promise<AutocompleteSuggestion[]> =>
        fetchRows(
          new URLSearchParams({
            $select: SEARCH_FIELDS.join(','),
            $where: where,
            $order: 'address',
            $limit: String(config.searchRowLimit),
          }),
        ).then(toSuggestions);

      let suggestions = await search(`starts_with(upper(address),${soqlString(q)})`);
      // #701 fallback: at most one more City request, only when the query has
      // a house number and a street token (e.g. a unit's building, or a
      // wrong street type) — house number + street name, anywhere in the key.
      if (suggestions.length === 0 && parsed.houseNumber && parsed.streetName) {
        suggestions = await search(fallbackPredicate(parsed.houseNumber, parsed.streetName));
      }
      const response: AutocompleteResponse = { suggestions };
      store(searchCache, q, response);
      if (suggestions.length === 0) {
        const { reason, key } = autocompleteMiss(parsed);
        deps.onLookupMiss?.(reason, key);
      }
      return response;
    },

    async getProperty(
      addressKey: string,
      options: GetPropertyOptions = {},
    ): Promise<PropertyRecord> {
      const key = addressKey.trim();
      if (!key) miss(addressKey, '', deps.onLookupMiss);
      // Reno/05: an explicit out-of-coverage key never hits Socrata.
      if (detectCoverageSignal(key) === 'out-of-coverage') {
        miss(key, key, deps.onLookupMiss);
      }
      const hit = cached(propertyCache, key);
      if (hit) return withLandUse(key, hit, options);

      const params = new URLSearchParams({
        $select: DETAIL_FIELDS.join(','),
        $where: `address=${soqlString(key)}`,
        $limit: String(config.searchRowLimit),
      });
      const entry = toProperty(key, await fetchRows(params));
      store(propertyCache, key, entry);
      return withLandUse(key, entry, options);
    },
  };
}
