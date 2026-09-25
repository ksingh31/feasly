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
 */
import type {
  AutocompleteResponse,
  AutocompleteSuggestion,
  PropertyRecord,
} from '@feasly/contracts';
import { HttpError, ErrorCodes } from '../middleware/errors';
import type { PropertyDataConfig } from '../config';

/** Raw Socrata row from the "Current Year Property Assessments (Parcel)" dataset. */
interface AssessmentRow {
  readonly roll_year?: string | number;
  readonly address?: string;
  readonly assessed_value?: string | number;
  readonly comm_name?: string;
  readonly year_of_construction?: string | number;
  readonly land_use_designation?: string;
  readonly land_size_sf?: string | number;
  readonly mod_date?: string;
}

/** Columns read for autocomplete (kept narrow: less over the wire). */
const SEARCH_FIELDS = ['address', 'comm_name'];
/** Columns read for a full property record. */
const DETAIL_FIELDS = [
  'roll_year',
  'address',
  'assessed_value',
  'comm_name',
  'year_of_construction',
  'land_use_designation',
  'land_size_sf',
  'mod_date',
];

/** Minimum query length, mirroring the frontend autocomplete gate. */
const MIN_QUERY_CHARS = 3;

/**
 * Natural street-type spellings users type, mapped to the abbreviations the
 * City dataset actually stores. Sourced from the City of Calgary's official
 * STREET_TYPE list plus a live sample of the assessment dataset 4bsw-nn7w:
 * every street-type token observed is a two-letter abbreviation ("1600 90 AV
 * SW", never "AVE").
 */
const STREET_TYPE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  ALLEY: 'AL', AVENUE: 'AV', AVE: 'AV', BAY: 'BA', BOULEVARD: 'BV', BLVD: 'BV',
  CAPE: 'CA', CENTRE: 'CE', CTR: 'CE', CIRCLE: 'CI', CIR: 'CI', CLOSE: 'CL',
  COMMON: 'CM', COURT: 'CO', CRT: 'CO', COVE: 'CV', CRESCENT: 'CR', CRES: 'CR',
  DRIVE: 'DR', GATE: 'GA', GARDEN: 'GD', GARDENS: 'GD', GREEN: 'GR', GROVE: 'GV',
  HEATH: 'HE', HEIGHTS: 'HT', HIGHWAY: 'HI', HWY: 'HI', HILL: 'HL', ISLAND: 'IS',
  ISLE: 'IS', LANDING: 'LD', LANE: 'LN', LINK: 'LI', MANOR: 'MR', MEWS: 'ME',
  MOUNT: 'MT', PARADE: 'PR', PARK: 'PA', PARKWAY: 'PY', PKY: 'PY', PASS: 'PS',
  PASSAGE: 'PS', PATH: 'PH', PLACE: 'PL', PLAZA: 'PZ', PLZ: 'PZ', POINT: 'PT',
  RISE: 'RI', ROAD: 'RD', ROW: 'RO', SQUARE: 'SQ', STREET: 'ST', TERRACE: 'TC',
  TERR: 'TC', TRAIL: 'TR', VIEW: 'VW', VILLA: 'VI', VILLAS: 'VI', WALK: 'WK',
  WAY: 'WY',
};

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
  getProperty(addressKey: string): Promise<PropertyRecord>;
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
 * Normalizes for SoQL prefix search: uppercase, single-spaced, and natural
 * street-type spellings ("AVE", "STREET") rewritten to the abbreviations the
 * City dataset stores ("AV", "ST").
 */
function normalizeQuery(query: string): string {
  const tokens = query.trim().replace(/\s+/g, ' ').toUpperCase().split(' ');
  const typeIndex =
    tokens.length >= 2 && QUADRANT.test(tokens[tokens.length - 1])
      ? tokens.length - 2
      : tokens.length - 1;
  const abbreviation = STREET_TYPE_ABBREVIATIONS[tokens[typeIndex]];
  if (abbreviation !== undefined) tokens[typeIndex] = abbreviation;
  return tokens.join(' ');
}

function notFound(): HttpError {
  return new HttpError(
    404,
    ErrorCodes.NOT_FOUND,
    'No City record for that address yet.',
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
  const assessmentYear = toNumber(row.roll_year) ?? new Date().getFullYear();
  const modDate = row.mod_date?.split('T')[0] ?? '';
  return {
    addressKey: address,
    address: `${formatAddress(address)}, Calgary, AB`,
    community: row.comm_name?.trim() || 'Calgary',
    lotSqft: Math.round(toNumber(row.land_size_sf) ?? 0),
    zoning: row.land_use_designation?.trim() ?? '',
    assessedValue: Math.round(assessedValue),
    assessmentYear,
    yearBuilt: toNumber(row.year_of_construction),
    dataAsOf: modDate || new Date().toISOString().split('T')[0],
    stale: assessmentYear < new Date().getFullYear(),
  };
}

export function createPropertyService(config: PropertyDataConfig): PropertyService {
  const resourceUrl = `${config.socrataBaseUrl}/resource/${config.datasetId}.json`;
  const searchCache = new Map<string, CacheEntry<AutocompleteResponse>>();
  const propertyCache = new Map<string, CacheEntry<PropertyRecord>>();

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
   * assessed value are skipped; none usable means NOT_FOUND.
   */
  function toProperty(key: string, body: unknown): PropertyRecord {
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
    if (!best || bestValue < 0) throw notFound();
    return toPropertyRecord(best);
  }

  return {
    async autocomplete(query: string): Promise<AutocompleteResponse> {
      const q = normalizeQuery(query);
      if (q.length < MIN_QUERY_CHARS) return { suggestions: [] };
      const hit = cached(searchCache, q);
      if (hit) return hit;

      const params = new URLSearchParams({
        $select: SEARCH_FIELDS.join(','),
        $where: `starts_with(upper(address),${soqlString(q)})`,
        $order: 'address',
        $limit: String(config.searchRowLimit),
      });
      const suggestions = toSuggestions(await fetchRows(params));
      const response: AutocompleteResponse = { suggestions };
      store(searchCache, q, response);
      return response;
    },

    async getProperty(addressKey: string): Promise<PropertyRecord> {
      const key = addressKey.trim();
      if (!key) throw notFound();
      const hit = cached(propertyCache, key);
      if (hit) return hit;

      const params = new URLSearchParams({
        $select: DETAIL_FIELDS.join(','),
        $where: `address=${soqlString(key)}`,
        $limit: String(config.searchRowLimit),
      });
      const property = toProperty(key, await fetchRows(params));
      store(propertyCache, key, property);
      return property;
    },
  };
}
