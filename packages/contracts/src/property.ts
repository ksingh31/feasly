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

/**
 * Why a property was (or was not) steered toward redevelopment (#755).
 * - `age_at_or_over_threshold`: built `thresholdYears`+ years ago → redevelopment candidate.
 * - `age_under_threshold`: younger home → renovation is usually the better fit.
 * - `year_built_unknown`: no City year of construction → no steering.
 */
export type PropertySteerReason =
  | 'age_at_or_over_threshold'
  | 'age_under_threshold'
  | 'year_built_unknown';

/**
 * Server-computed project-type steer (#755). The rule (home age vs the
 * market's threshold) lives in the API's market config; clients only read it.
 * Renovation is offered at any age; a younger home may still continue with a
 * new build (the override).
 */
export interface PropertySteer {
  /** True for homes at/over the threshold age, false under it, null when the year is unknown. */
  readonly redevelopmentCandidate: boolean | null;
  readonly reason: PropertySteerReason;
  /** The project type offered first; null = no steering (show both equally). */
  readonly recommendedProjectType: 'new_build' | 'renovation' | null;
  /** Home age in whole years at lookup time; null when the year is unknown. */
  readonly homeAgeYears: number | null;
  /** The market's redevelopment age threshold, in years. */
  readonly thresholdYears: number;
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
  /**
   * Project-type steer by home age (#755). Optional (additive): cached or
   * stored records from before this field, and non-API data sources, omit
   * it — treat absent as "no steering".
   */
  readonly steer?: PropertySteer;
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
