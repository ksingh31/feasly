/**
 * Zoning rules catalogue contracts (issue #687).
 *
 * One versioned table per city says, for each land-use district, which
 * building forms are typically allowed and the few rules homeowners ask
 * about (height, lot coverage, density, units on a lot). The table is DATA
 * (`packages/zoning/src/data/`), resolved by a pure resolver; these are the
 * shapes it is written in and served as.
 *
 * Two layers:
 * - **Source** (`ZoningRulesVersion` / `ZoningDistrictSource`): the catalogue
 *   as written, every value carrying a bylaw section and a `verified` flag.
 * - **Public** (`ZoningDistrict` / `ZoningDistrictsResponse`): what the API
 *   serves. Unverified values are ABSENT here — consumers show "see the
 *   City's bylaw" instead. There is no `verified` field on the wire because
 *   everything on the wire is verified.
 *
 * No dollar figure appears anywhere in these shapes (CLAUDE.md: every
 * dollar figure comes from the cost engine).
 */

/** Fixed building-form vocabulary. A district lists a subset. */
export type BuildingForm =
  | 'single-detached'
  | 'semi-detached'
  | 'duplex'
  | 'rowhouse'
  | 'townhouse'
  | 'secondary-suite'
  | 'backyard-suite'
  | 'multi-residential';

/** The vocabulary as a runtime list (stable display order). */
export const BUILDING_FORMS: readonly BuildingForm[] = [
  'single-detached',
  'semi-detached',
  'duplex',
  'rowhouse',
  'townhouse',
  'secondary-suite',
  'backyard-suite',
  'multi-residential',
];

/** Broad district family. */
export type ZoningDistrictCategory =
  | 'low-density'
  | 'grade-oriented'
  | 'multi-residential'
  | 'mixed-use'
  | 'direct-control'
  | 'non-residential';

/**
 * How far the catalogue speaks for a district:
 * - `covered` — forms/rules listed (verified ones only, on the wire);
 * - `site-specific` — Direct Control: rules live in the parcel's DC bylaw;
 * - `not-covered` — a known district Feasly deliberately says nothing about
 *   (commercial, industrial, special purpose, …).
 */
export type ZoningCoverage = 'covered' | 'site-specific' | 'not-covered';

/** Permitted = approved if it meets the rules; discretionary = the City decides. */
export type FormPermission = 'permitted' | 'discretionary';

/** A building form a district allows, as written in the catalogue. */
export interface ZoningFormSource {
  readonly form: BuildingForm;
  readonly permission: FormPermission;
  /** Bylaw section reference, e.g. "s. 385(1)(b)". */
  readonly section: string;
  /** Only verified values ever leave the resolver. */
  readonly verified: boolean;
  readonly note?: string;
}

/** One numeric rule as written in the catalogue. */
export interface ZoningRuleSource {
  readonly value: number;
  readonly section: string;
  readonly verified: boolean;
  /** Plain-language qualifier ("11.0 m on parcels under 400 m²"). */
  readonly note?: string;
}

/** The key rules people ask about. Every one is optional. */
export interface ZoningKeyRulesSource {
  readonly maxHeightM?: ZoningRuleSource;
  readonly maxLotCoveragePct?: ZoningRuleSource;
  readonly maxDensityUnitsPerHa?: ZoningRuleSource;
  /** Only where the district fixes a unit count outright. */
  readonly maxUnitsOnLot?: ZoningRuleSource;
}

/** One district in the source catalogue. */
export interface ZoningDistrictSource {
  /** Code as the City publishes it (`R-C1s`). Lookup is case-insensitive. */
  readonly code: string;
  readonly name: string;
  readonly category: ZoningDistrictCategory;
  readonly coverage: ZoningCoverage;
  /** Other spellings / legacy codes that mean this district. */
  readonly aliases?: readonly string[];
  readonly forms: readonly ZoningFormSource[];
  readonly rules: ZoningKeyRulesSource;
  /** Short plain-language note shown with the district. */
  readonly note?: string;
}

/** One city's catalogue, versioned by the date the rules took effect. */
export interface ZoningRulesVersion {
  /** Lower-case city key, e.g. "calgary". */
  readonly city: string;
  /** ISO date the rules took effect, e.g. "2026-08-04". */
  readonly effectiveDate: string;
  /** Bylaw title, e.g. "Land Use Bylaw 1P2007". */
  readonly bylaw: string;
  /** Which text of the bylaw the sections were read from. */
  readonly bylawVersion: string;
  /** Where a homeowner confirms the rules (the City's bylaw page). */
  readonly sourceUrl: string;
  readonly districts: readonly ZoningDistrictSource[];
}

// ── Public (verified-only) shapes ────────────────────────────────────────

/** A verified building form. */
export interface ZoningForm {
  readonly form: BuildingForm;
  readonly permission: FormPermission;
  readonly section: string;
  readonly note?: string;
}

/** A verified numeric rule. */
export interface ZoningRule {
  readonly value: number;
  readonly section: string;
  readonly note?: string;
}

/** Verified key rules; an absent key means "see the City's bylaw". */
export interface ZoningKeyRules {
  readonly maxHeightM?: ZoningRule;
  readonly maxLotCoveragePct?: ZoningRule;
  readonly maxDensityUnitsPerHa?: ZoningRule;
  readonly maxUnitsOnLot?: ZoningRule;
}

/** A district as served: verified values only. */
export interface ZoningDistrict {
  readonly code: string;
  readonly name: string;
  readonly category: ZoningDistrictCategory;
  readonly coverage: ZoningCoverage;
  readonly aliases: readonly string[];
  readonly forms: readonly ZoningForm[];
  readonly rules: ZoningKeyRules;
  readonly note?: string;
}

/**
 * How current the served catalogue is against the City's own sources
 * (#757). A daily watcher checks the Land Use Districts dataset and the
 * Land Use Bylaw page; when the City changed something after the
 * catalogue's `effectiveDate`, `stale` is true and the panel shows a
 * "rules recently changed — confirm with the City" note until the
 * catalogue is updated.
 */
export interface ZoningCatalogueFreshness {
  /** ISO date the catalogue's rules are as of (its `effectiveDate`). */
  readonly rulesAsOf: string;
  /** True when the City changed its rules or districts after `rulesAsOf`. */
  readonly stale: boolean;
  /** ISO date of the latest City change the watcher detected; null when none. */
  readonly latestChangeDetectedOn: string | null;
}

/** `GET /api/v1/zoning/districts` — the active catalogue for the city. */
export interface ZoningDistrictsResponse {
  readonly city: string;
  readonly effectiveDate: string;
  readonly bylaw: string;
  readonly bylawVersion: string;
  readonly sourceUrl: string;
  readonly districts: readonly ZoningDistrict[];
  /**
   * Catalogue freshness (#757). Present on API responses; absent when the
   * catalogue is projected without the watcher (pure resolver output).
   */
  readonly freshness?: ZoningCatalogueFreshness;
}
