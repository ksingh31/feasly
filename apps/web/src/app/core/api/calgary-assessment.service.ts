import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, of, throwError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  ApiError,
  AutocompleteResponse,
  AutocompleteSuggestion,
  PropertyRecord,
} from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import type { PropertyDataService } from './property-data.service';

/**
 * Raw Socrata row from the City of Calgary "Current Year Property
 * Assessments (Parcel)" dataset. Fields are optional because the API omits
 * empty columns, and numeric columns arrive as numbers or numeric strings.
 * Live schema verified 2026-08-12.
 */
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

/** Minimum query length, mirroring the autocomplete component's gate. */
const MIN_QUERY_CHARS = 3;

/**
 * Natural street-type spellings users type, mapped to the abbreviations the
 * City dataset actually stores. Derived from a 50k-row live sample of dataset
 * 4bsw-nn7w (2026-09-24): every one of the 45 distinct street-type tokens is a
 * two-letter abbreviation ("1600 90 AV SW", never "AVE"). Without this,
 * natural input like "1600 90 Ave SW" prefix-matches zero rows and the UI
 * reports "address not found" for valid Calgary addresses.
 *
 * Only the token in street-type position (immediately before a trailing
 * quadrant, else the last token) is rewritten, so street names containing
 * these words are never corrupted: "PARK AVE SW" -> "PARK AV SW".
 * Tokens already abbreviated ("AV") or unknown pass through untouched.
 */
const STREET_TYPE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  AVENUE: 'AV',
  AVE: 'AV',
  BOULEVARD: 'BV',
  BLVD: 'BV',
  STREET: 'ST',
  DRIVE: 'DR',
  CRESCENT: 'CR',
  CRES: 'CR',
  ROAD: 'RD',
  PLACE: 'PL',
  WAY: 'WY',
  CLOSE: 'CL',
  CIRCLE: 'CI',
  CIR: 'CI',
  COURT: 'CO',
  CRT: 'CO',
  PARK: 'PA',
  PARADE: 'PR',
  PARKWAY: 'PY',
  PKY: 'PY',
  TERRACE: 'TC',
  MANOR: 'MR',
  GREEN: 'GR',
  COMMON: 'CM',
  GARDEN: 'GD',
  GARDENS: 'GD',
  VIEW: 'VW',
  RISE: 'RI',
  BAY: 'BA',
  HEIGHTS: 'HT',
  POINT: 'PT',
  LANDING: 'LD',
  SQUARE: 'SQ',
  GROVE: 'GV',
  MEWS: 'ME',
  LANE: 'LN',
  WALK: 'WK',
  LINK: 'LI',
  VISTA: 'VI',
  HILL: 'HL',
  GATE: 'GA',
  PLAZA: 'PZ',
  TRAIL: 'TR',
  HEATH: 'HE',
  COVE: 'CV',
  ROW: 'RO',
  PASS: 'PS',
  ISLAND: 'IS',
  ISLE: 'IS',
};

/** Trailing quadrant token stays uppercase: "16 AVE NW" -> "16 Ave NW". */
const QUADRANT = /^(NW|NE|SW|SE)$/i;

interface CacheEntry<T> {
  readonly expires: number;
  readonly value: T;
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

/** Guards errors we already shaped (e.g. not_found) from being re-wrapped. */
function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiError).code === 'string'
  );
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
 * Live City of Calgary property data (FE1-002): address autocomplete and
 * property records straight from the City's open-data Socrata API — free,
 * no key required. Anonymous Socrata requests are rate-limited per IP, so
 * this service leans on the component's debounce plus a short response
 * cache (TTL from config) instead of hammering the API.
 *
 * Degradation contract: zero results resolve to an empty suggestion list
 * (the component shows its no-results copy); transport failures and
 * timeouts surface as retryable `city_data_unavailable` ApiErrors so the
 * component shows its error + retry UI instead of crashing.
 */
@Injectable({ providedIn: 'root' })
export class CalgaryAssessmentService implements PropertyDataService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private readonly searchCache = new Map<string, CacheEntry<AutocompleteResponse>>();
  private readonly propertyCache = new Map<string, CacheEntry<PropertyRecord>>();

  private get resourceUrl(): string {
    const { baseUrl, datasetId } = this.config.get('propertyData');
    return `${baseUrl}/resource/${datasetId}.json`;
  }

  private cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private store<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, { expires: Date.now() + this.config.get('propertyData').cacheTtlMs, value });
  }

  /**
   * Normalizes for SoQL prefix search: uppercase, single-spaced, and natural
   * street-type spellings ("AVE", "STREET") rewritten to the abbreviations the
   * City dataset stores ("AV", "ST") — see STREET_TYPE_ABBREVIATIONS.
   */
  private normalizeQuery(query: string): string {
    const tokens = query.trim().replace(/\s+/g, ' ').toUpperCase().split(' ');
    // The street-type token sits immediately before a trailing quadrant;
    // without a quadrant it is the last token.
    const typeIndex =
      tokens.length >= 2 && QUADRANT.test(tokens[tokens.length - 1])
        ? tokens.length - 2
        : tokens.length - 1;
    const abbreviation = STREET_TYPE_ABBREVIATIONS[tokens[typeIndex]];
    if (abbreviation !== undefined) tokens[typeIndex] = abbreviation;
    return tokens.join(' ');
  }

  private cityUnavailable(): Observable<never> {
    return throwError(
      (): ApiError => ({
        code: 'city_data_unavailable',
        message: this.config.get('copy').search.error,
        retryable: true,
      }),
    );
  }

  private passThrough(error: unknown): Observable<never> {
    return isApiError(error) ? throwError(() => error) : this.cityUnavailable();
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    const q = this.normalizeQuery(query);
    if (q.length < MIN_QUERY_CHARS) return of({ suggestions: [] });
    const hit = this.cached(this.searchCache, q);
    if (hit) return of(hit);

    const params = new HttpParams()
      .set('$select', SEARCH_FIELDS.join(','))
      .set('$where', 'starts_with(upper(address),' + soqlString(q) + ')')
      .set('$order', 'address')
      .set('$limit', String(this.config.get('propertyData').searchRowLimit));
    return this.http.get<unknown>(this.resourceUrl, { params }).pipe(
      timeout(this.config.get('api').timeoutMs),
      map((body) => this.toSuggestions(body)),
      map((suggestions) => ({ suggestions })),
      map((response) => {
        this.store(this.searchCache, q, response);
        return response;
      }),
      catchError((error: unknown) => this.passThrough(error)),
    );
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    const key = addressKey.trim();
    if (!key) return throwError(() => notFound());
    const hit = this.cached(this.propertyCache, key);
    if (hit) return of(hit);

    const params = new HttpParams()
      .set('$select', DETAIL_FIELDS.join(','))
      .set('$where', 'address=' + soqlString(key))
      .set('$limit', String(this.config.get('propertyData').searchRowLimit));
    return this.http.get<unknown>(this.resourceUrl, { params }).pipe(
      timeout(this.config.get('api').timeoutMs),
      map((body) => this.toProperty(key, body)),
      map((property) => {
        this.store(this.propertyCache, key, property);
        return property;
      }),
      catchError((error: unknown) => this.passThrough(error)),
    );
  }

  private toSuggestions(body: unknown): AutocompleteSuggestion[] {
    if (!Array.isArray(body)) return [];
    const limit = this.config.get('limits').autocompleteSuggestionLimit;
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
      if (suggestions.length >= limit) break;
    }
    return suggestions;
  }

  /**
   * Picks one record for an exact address. Parcels can share an address
   * (condos, multi-parcel lots), so the choice is deterministic: the row
   * with the highest assessed value. Rows without a parseable address or
   * assessed value are skipped; none usable means `not_found`.
   */
  private toProperty(key: string, body: unknown): PropertyRecord {
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
}

/** `not_found` for an unknown address key — same shape as the mock harness. */
function notFound(): ApiError {
  return { code: 'not_found', message: 'No City record for that address yet.', retryable: false };
}

/** Maps one verified Socrata row onto the FE0-001 PropertyRecord contract. */
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
