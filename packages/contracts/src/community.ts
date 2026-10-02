/**
 * Community-aggregates contracts for the SEO content pipeline. Build-time only:
 * the generator writes this file, the prerender step reads it. Per-sqft figures
 * and margins must never appear here (deny-list scanned in FE-6).
 */

export interface CommunityAggregate {
  /** kebab-case, unique. */
  readonly slug: string;
  readonly name: string;
  /** Assessment record count — drives the top-N page selection. */
  readonly count: number;
  /** Average City-assessed value, integer CAD. */
  readonly avgAssessedValue: number;
  readonly avgLotSqft: number;
}

export interface CommunityAggregatesFile {
  readonly generatedAt: string;
  readonly costDataVersion: string;
  readonly communities: readonly CommunityAggregate[];
}

/**
 * Community page type. `build-guide` communities get the single-family
 * build-cost guide; `profile` communities (condo/apartment-dominated, where
 * a per-house build figure would be misleading) get the property-values
 * profile instead.
 */
export type CommunityType = 'build-guide' | 'profile';

/** Dwelling-mix buckets, from City assessment `sub_property_use` codes. */
export type DwellingBucket = 'singleDetached' | 'semiDuplex' | 'multiFamily';

export interface CommunityDwellingMix {
  /** kebab-case, matches community-aggregates.json. */
  readonly slug: string;
  readonly communityType: CommunityType;
  /** Residential dwelling assessment records (excludes condo common elements, parking, storage). */
  readonly dwellingUnits: number;
  readonly mix: Readonly<Record<DwellingBucket, number>>;
  readonly mostCommonType: DwellingBucket;
}

export interface CommunityMixFile {
  readonly generatedAt: string;
  /** Assessment roll year the mix was computed from, e.g. "2026". */
  readonly assessmentYear: string;
  readonly communities: readonly CommunityDwellingMix[];
}
