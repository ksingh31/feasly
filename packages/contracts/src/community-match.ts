/**
 * Community match contract (#778, Community Match epic).
 *
 * POST /api/v1/communities/match — public, ungated. Priorities (each `must`
 * or `nice`) plus optional lot filters in; established infill communities
 * (#690) ranked by a deterministic 0–100 match out, each with its top reasons,
 * misses, lot counts (#691) and a typical new-build range from the cost
 * engine.
 *
 * Scored only from Feasly's tables (monthly/weekly refreshes of City of
 * Calgary open data); a visitor never triggers an outside call. Distances
 * are straight-line, schools are "typically designated", frontage is
 * estimated from lot area. Every dollar figure comes from the cost engine.
 */

/** How much a priority matters. A failed `must` ranks the community below every community that passes. */
export type CommunityMatchImportance = 'must' | 'nice';

export const COMMUNITY_MATCH_IMPORTANCE: readonly CommunityMatchImportance[] = ['must', 'nice'];

/** Priority key for City-maintained public tree cover (#777). */
export const TREE_COVER_PRIORITY = 'tree-cover';

/** Priority key for typically designated schools across every grade band (#775). */
export const DESIGNATED_SCHOOLS_PRIORITY = 'designated-schools';

/**
 * One priority. `key` is an amenity category key from config ('parks',
 * 'playgrounds', 'pathways', 'rec-centres', 'pools', 'libraries', …),
 * `'tree-cover'` or `'designated-schools'`. Keys are unique per request.
 */
export interface CommunityMatchPriority {
  readonly key: string;
  readonly importance: CommunityMatchImportance;
}

export interface CommunityMatchFilters {
  /**
   * Minimum lot frontage in feet. Frontage is estimated from each listed
   * lot's area over a typical inner-city lot depth (config).
   */
  readonly minFrontageFt?: number;
  /** Only communities with at least one listed lot (meeting `minFrontageFt`, when set). */
  readonly lotsListedNow?: boolean;
}

/** POST /api/v1/communities/match body. */
export interface CommunityMatchRequest {
  /** 1+ priorities, unique keys. */
  readonly priorities: readonly CommunityMatchPriority[];
  readonly filters?: CommunityMatchFilters;
  /** Results to return (default and cap from config). */
  readonly limit?: number;
}

/** One reason (met priority) or miss (unmet priority), in plain words. */
export interface CommunityMatchNote {
  /** The priority key, or 'lots' / 'established' for the fallback reason. */
  readonly priority: string;
  readonly importance: CommunityMatchImportance | null;
  readonly text: string;
}

export interface CommunityMatchLots {
  /** Lots listed now in the community (#691). */
  readonly listed: number;
  /** Listed lots meeting `minFrontageFt` (equals `listed` without that filter). */
  readonly matching: number;
  /** When the community's lots were last refreshed; null when it has no inventory row. */
  readonly refreshedAt: string | null;
}

/** Typical new-build cost range from the cost engine (whole CAD). */
export interface CommunityMatchBuildRange {
  readonly low: number;
  readonly high: number;
}

export interface CommunityMatchResult {
  /** 1-based position in the full ranking. */
  readonly rank: number;
  /** City community code, e.g. 'ALT'. */
  readonly communityCode: string;
  readonly name: string;
  /** kebab-case, matches the community pages. */
  readonly slug: string;
  /** 0–100, weighted (must > nice). */
  readonly match: number;
  /** False when any must-have priority is missed — ranked below every community that passes. */
  readonly passesMustHaves: boolean;
  /** At least one, strongest first. */
  readonly reasons: readonly CommunityMatchNote[];
  /** Every unmet priority, must-haves first. */
  readonly misses: readonly CommunityMatchNote[];
  readonly lots: CommunityMatchLots;
  /** Typical new-build range on the community's average lot; null without lot-size data. */
  readonly typicalNewBuild: CommunityMatchBuildRange | null;
}

/** The house the typical new-build ranges are priced for. */
export interface CommunityMatchBuildBasis {
  readonly buildSqft: number;
  readonly tier: string;
  readonly costDataVersion: string;
  /** False while the cost table is an uncalibrated draft. */
  readonly calibrated: boolean;
}

export interface CommunityMatchResponse {
  readonly results: readonly CommunityMatchResult[];
  /** Communities ranked after filters (results may be capped by `limit`). */
  readonly total: number;
  readonly buildBasis: CommunityMatchBuildBasis;
  /** Always 'straight-line' — distances are never travel times. */
  readonly distanceBasis: 'straight-line';
  /** Always 'estimated-from-lot-area'. */
  readonly frontageBasis: 'estimated-from-lot-area';
  /** Newest monthly refresh behind the community metrics; null when none. */
  readonly dataRefreshedAt: string | null;
  readonly disclaimer: string;
}
