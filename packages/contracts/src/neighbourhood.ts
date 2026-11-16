/**
 * Community "living nearby" contract (#777, Community Match epic).
 *
 * GET /api/v1/communities/{slug}/living — public, ungated. Served only from
 * Feasly's tables (refreshed monthly from City of Calgary open data); a
 * visitor never triggers an outside call. Distances are straight-line from
 * the community centre, never travel times. No dollar figures.
 */

/** One amenity category around the community centre. */
export interface CommunityAmenityMetricDto {
  /** Config key, e.g. 'parks', 'playgrounds', 'pathways', 'rec-centres'. */
  readonly category: string;
  /** Display label, e.g. 'Parks'. */
  readonly label: string;
  /** Nearest one within `searchRadiusM`; null when none. */
  readonly nearest: { readonly name: string; readonly distanceM: number } | null;
  /** Count within each radius (e.g. 500 m, 1 km), smallest first. */
  readonly counts: readonly { readonly radiusM: number; readonly count: number }[];
}

/**
 * City-maintained public trees per hectare of community area, bucketed by
 * configured thresholds. A count of public trees — not a measured canopy.
 */
export interface CommunityTreeCoverDto {
  readonly publicTrees: number;
  readonly areaHa: number;
  readonly treesPerHa: number;
  readonly level: 'low' | 'moderate' | 'high';
}

export interface CommunityLivingResponse {
  /** City community code, e.g. 'ALT'. */
  readonly communityCode: string;
  readonly name: string;
  /** kebab-case, matches the community pages. */
  readonly slug: string;
  /** Always 'straight-line' — distances are never travel times. */
  readonly distanceBasis: 'straight-line';
  readonly searchRadiusM: number;
  /** One entry per configured category, in config order. */
  readonly amenities: readonly CommunityAmenityMetricDto[];
  readonly treeCover: CommunityTreeCoverDto | null;
  /** ISO timestamp of the monthly refresh behind these figures. */
  readonly dataRefreshedAt: string;
}
