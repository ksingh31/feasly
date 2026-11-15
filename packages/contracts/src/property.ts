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
  /**
   * Assessment roll year. When the City row carries no roll year this is a
   * fallback (the current year) and `assessmentYearInferred` is true — never
   * display it as a fact in that case (#622).
   */
  readonly assessmentYear: number;
  /**
   * True when the City row had no roll year and `assessmentYear` was filled
   * with a fallback. Optional during the expand phase (#622): records cached
   * or persisted before this field existed omit it — treat absent as false.
   */
  readonly assessmentYearInferred?: boolean;
  readonly yearBuilt: number | null;
  /** City assessment class code, verbatim (e.g. 'R', 'NR'). */
  readonly assessmentClass: string;
  /** True when the City classifies the parcel non-residential (commercial/industrial). */
  readonly isNonResidential: boolean;
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
