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
