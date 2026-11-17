/**
 * School designation contracts (issue #775, Community Match epic).
 *
 * The Calgary Board of Education (CBE) and Calgary Catholic School District
 * (CCSD) publish designated schools by community, not as an open boundary
 * file. The monthly refresh stores them per community and grade band, and
 * these responses serve them from our own tables — a visitor never triggers
 * an outside call.
 *
 * Copy rule: a designation is always "typically designated" — it can vary by
 * address and change year to year, so every response carries each board's
 * address lookup link to confirm. Free and ungated; no dollar figures.
 */

/** School boards that publish designations. */
export type SchoolBoardId = 'cbe' | 'ccsd';

/** The board vocabulary as a runtime list (stable display order). */
export const SCHOOL_BOARD_IDS: readonly SchoolBoardId[] = ['cbe', 'ccsd'];

/** Grade bands a board designates a school for. */
export type DesignationGradeBand = 'K-6' | 'K-9' | '7-9' | '10-12';

/** The grade-band vocabulary as a runtime list (display order). */
export const DESIGNATION_GRADE_BANDS: readonly DesignationGradeBand[] = ['K-6', 'K-9', '7-9', '10-12'];

/** The only label a designation is ever shown with. */
export const TYPICALLY_DESIGNATED = 'typically designated';

/** One board and the page where a family confirms the school for an exact address. */
export interface SchoolBoardLookup {
  readonly board: SchoolBoardId;
  /** Display name, e.g. "Calgary Board of Education". */
  readonly name: string;
  readonly lookupUrl: string;
}

/** One typically designated school for a community, board and grade band. */
export interface SchoolDesignation {
  readonly board: SchoolBoardId;
  readonly boardName: string;
  readonly gradeBand: DesignationGradeBand;
  readonly schoolName: string;
  /** Always "typically designated". */
  readonly label: typeof TYPICALLY_DESIGNATED;
  /** The board's address lookup — confirm the exact address there. */
  readonly lookupUrl: string;
  /** When the monthly refresh last wrote or confirmed this designation (ISO 8601). */
  readonly refreshedAt: string;
}

/** Fields both designation responses share. */
export interface SchoolDesignationsBase {
  /** Always "typically designated". */
  readonly label: typeof TYPICALLY_DESIGNATED;
  /** Board, then grade-band order. Empty when none are stored. */
  readonly designations: readonly SchoolDesignation[];
  /** Every board's address lookup link (present even when `designations` is empty). */
  readonly boards: readonly SchoolBoardLookup[];
  /** Copy guard: confirm with the board. */
  readonly disclaimer: string;
}

/** GET /api/v1/communities/{slug}/school-designations */
export interface CommunitySchoolDesignationsResponse extends SchoolDesignationsBase {
  readonly communityCode: string;
  readonly communityName: string;
  readonly slug: string;
}

/** GET /api/v1/school-designations?addressKey= (resolved via the address's community). */
export interface AddressSchoolDesignationsResponse extends SchoolDesignationsBase {
  readonly addressKey: string;
  /** City community code, when the address is in an established community we cover. */
  readonly communityCode: string | null;
  /** The address's community as the City names it; null when unknown. */
  readonly communityName: string | null;
  readonly slug: string | null;
}
