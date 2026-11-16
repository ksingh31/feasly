/**
 * Nearby building and development permits (#822).
 *
 * Residential new-build building permits (BP) and development permits (DP)
 * from City of Calgary open data, refreshed monthly into Feasly's tables. A
 * visitor never triggers a City call. Public permit data only: applicant
 * names are never returned, and `builder` only when the City lists a
 * company. No dollar figures.
 */

export type PermitKind = 'building' | 'development';

/** One permit in the expandable list. */
export interface NearbyPermitDto {
  readonly kind: PermitKind;
  /** City permit number, e.g. 'BP2025-01234'. */
  readonly permitNumber: string;
  readonly address: string | null;
  /** BP permit class group ('Single Family') / DP category. */
  readonly permitType: string | null;
  /** City status as published, e.g. 'Issued Permit', 'Released'. */
  readonly status: string | null;
  /** Year of the BP issue / DP decision, else of the application. */
  readonly year: number | null;
  /** Company name when the City lists one; never a person. */
  readonly builder: string | null;
  /** Straight-line metres from the address. */
  readonly distanceM: number;
  /** The City's record for the permit. */
  readonly recordUrl: string;
}

/** GET /api/v1/properties/permits?addressKey=… */
export interface NearbyPermitsResponse {
  readonly addressKey: string;
  readonly radiusM: number;
  /** Counts cover permits from 1 January of this year. */
  readonly sinceYear: number;
  /** Residential new-build BPs issued within the radius since `sinceYear`. */
  readonly buildingPermits: number;
  /** Housing units on those BPs ("N new homes permitted"). */
  readonly newHomes: number;
  /** Residential DPs applied for within the radius since `sinceYear`. */
  readonly developmentPermits: number;
  /** Median weeks from DP application to BP issue at the same address; null when too few. */
  readonly typicalDpToBpWeeks: number | null;
  /** All permits in the window (BP or DP). */
  readonly total: number;
  /** Most recent first, at most the configured limit. */
  readonly permits: readonly NearbyPermitDto[];
  /** ISO timestamp of the monthly City refresh behind these figures. */
  readonly dataRefreshedAt: string;
}

export interface CommunityPermitYearDto {
  readonly year: number;
  /** Residential new-build BPs issued that year. */
  readonly buildingPermits: number;
  readonly newHomes: number;
  /** Residential DPs decided that year. */
  readonly developmentPermits: number;
}

/** GET /api/v1/communities/{slug}/permits */
export interface CommunityPermitsResponse {
  readonly communityCode: string;
  readonly name: string;
  readonly slug: string;
  /** Oldest year first, through the current year. */
  readonly perYear: readonly CommunityPermitYearDto[];
  /** Medians cover permits decided from 1 January of this year. */
  readonly sinceYear: number;
  /** Median weeks; null when too few permits to say. */
  readonly medianApprovalWeeks: {
    /** BP application → issue. */
    readonly buildingPermit: number | null;
    /** DP application → decision. */
    readonly developmentPermit: number | null;
    /** DP application → BP issue at the same address. */
    readonly dpToBp: number | null;
  };
  readonly dataRefreshedAt: string;
}
