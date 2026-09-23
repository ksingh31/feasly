/**
 * Property lookup contracts. The client never touches the City dataset directly —
 * it calls the API, which wraps it. All fields here are public City data.
 */

export type PropertyErrorCode =
  | 'not_found'
  | 'non_calgary'
  | 'service_down'
  | 'multi_unit';

export interface PropertyRecord {
  readonly addressKey: string;
  readonly address: string;
  readonly community: string;
  /** Lot size in square feet. */
  readonly lotSqft: number;
  /** City land-use designation, verbatim. */
  readonly zoning: string;
  /** City-assessed value, integer CAD (no cents). */
  readonly assessedValue: number;
  readonly assessmentYear: number;
  readonly yearBuilt: number | null;
  /** When the City data was fetched (ISO date). Shown under the assessed value. */
  readonly dataAsOf: string;
  /** True when the assessment year is older than the freshness threshold. */
  readonly stale: boolean;
}

export interface AutocompleteSuggestion {
  readonly addressKey: string;
  readonly address: string;
  readonly community: string;
}

export interface AutocompleteResponse {
  readonly suggestions: readonly AutocompleteSuggestion[];
}
