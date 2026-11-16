/**
 * Property lookup contracts. The client never touches the City dataset directly —
 * it calls the API, which wraps it. All fields here are public City data.
 */

export type PropertyErrorCode =
  | 'not_found'
  | 'non_calgary'
  | 'service_down'
  | 'multi_unit';

/**
 * Where a parcel's land-use district came from (#686):
 * - `land-use-districts`: the City's current Land Use Districts map
 *   (authoritative for "what can be built").
 * - `assessment-roll`: fallback — the assessment roll's designation, which
 *   reflects a past condition date (may be a stale pre-repeal pair).
 */
export type LandUseSource = 'land-use-districts' | 'assessment-roll';

/** Current land-use district for a parcel (#686). Public City data. */
export interface PropertyLandUse {
  /** District code, e.g. 'R-C2', 'R-CG', 'DC'. */
  readonly district: string;
  /** City description of the district; empty when the source has none. */
  readonly description: string;
  readonly source: LandUseSource;
  /** When the district was checked against the source (ISO date). */
  readonly asOf: string;
  /** Direct Control bylaw number (e.g. '48Z84') when district is 'DC' and known. */
  readonly dcBylaw?: string;
}

export interface PropertyRecord {
  readonly addressKey: string;
  readonly address: string;
  readonly community: string;
  /** Lot size in square feet. */
  readonly lotSqft: number;
  /**
   * City land-use designation. Carries the current district
   * (`landUse.district`) when it is known from the Land Use Districts map;
   * otherwise the assessment roll's designation, verbatim (#686).
   */
  readonly zoning: string;
  /**
   * Current land-use district and its source (#686). Optional (additive):
   * cached/stored records from before this field omit it.
   */
  readonly landUse?: PropertyLandUse;
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

/** One assessed value from the City's roll for one roll year (#695). */
export interface AssessmentHistoryPoint {
  /** Assessment roll year, e.g. 2025. */
  readonly rollYear: number;
  /** City-assessed value for that roll year, integer CAD (no cents). */
  readonly assessedValue: number;
}

/**
 * `GET /api/v1/properties/assessment` response (#695): the current property
 * record plus the City's year-by-year assessment history. Public City data,
 * free and ungated (owner, 2026-11-15). `PropertyRecord` is unchanged.
 */
export interface PropertyAssessmentResponse {
  readonly property: PropertyRecord;
  /**
   * The City's own "last modified" date for the current-year record (ISO
   * date), or null when the City row carries none.
   */
  readonly cityRecordUpdatedOn: string | null;
  /** Human-readable City assessment class, e.g. 'Residential'. */
  readonly propertyClassLabel: string;
  /**
   * Assessed value per roll year, newest first, one entry per roll year,
   * including the current roll year. Empty when `historyAvailable` is false.
   */
  readonly history: readonly AssessmentHistoryPoint[];
  /**
   * False when the City's history dataset was unavailable or has no rows for
   * this address (e.g. a new subdivision) — `history` is then empty.
   */
  readonly historyAvailable: boolean;
}
