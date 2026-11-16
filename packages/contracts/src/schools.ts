/**
 * Schools directory contracts (issue #774, Community Match epic).
 *
 * One list of Calgary K–12 schools built by the monthly refresh from free
 * public sources (City of Calgary Schools, the Alberta school authority
 * list, OpenStreetMap) and served from our own tables — a visitor never
 * triggers an outside call. Every field says which source it came from.
 *
 * Free and ungated. No dollar figure appears anywhere in these shapes
 * (CLAUDE.md: every dollar figure comes from the cost engine) — `tuition` is
 * a flag, never an amount.
 */

/** School type. Every school in the directory has exactly one. */
export type SchoolType =
  /** Calgary Board of Education (public). */
  | 'public_cbe'
  /** Calgary Catholic School District (separate). */
  | 'catholic_ccsd'
  /** Conseil scolaire FrancoSud (French first-language). */
  | 'francophone'
  /** Alberta public charter school. */
  | 'charter'
  /** Private (independent) school. */
  | 'private'
  /**
   * A program run in Calgary by a public school authority based outside the
   * city (e.g. faith-based alternative programs, online/outreach schools).
   */
  | 'alternative';

/** The type vocabulary as a runtime list (stable display order). */
export const SCHOOL_TYPES: readonly SchoolType[] = [
  'public_cbe',
  'catholic_ccsd',
  'francophone',
  'charter',
  'private',
  'alternative',
];

/** Program vocabulary (a school lists a subset; empty when none is known). */
export type SchoolProgram =
  | 'french-immersion'
  | 'international-baccalaureate'
  | 'advanced-placement'
  | 'arts'
  | 'spanish-bilingual'
  | 'german-bilingual'
  | 'mandarin-bilingual'
  | 'montessori'
  | 'waldorf'
  | 'stem'
  | 'sports'
  | 'indigenous-focus'
  | 'traditional-learning'
  | 'dual-credit'
  | 'outreach'
  | 'online';

/** Where a field's value came from. */
export type SchoolSourceId = 'calgary-open-data' | 'alberta-authority-list' | 'openstreetmap';

/** Attribution notice for one source (shown wherever the data is shown). */
export interface SchoolSourceAttribution {
  readonly id: SchoolSourceId;
  readonly label: string;
  readonly licence: string;
  readonly url: string;
}

/** Fields that carry per-field source attribution. */
export type SchoolAttributedField =
  | 'name'
  | 'type'
  | 'board'
  | 'authority'
  | 'grades'
  | 'programs'
  | 'address'
  | 'coordinates'
  | 'website'
  | 'tuition'
  | 'community';

/** One school, as served by the directory. */
export interface School {
  /** Stable id within the directory (path parameter of GET /schools/{id}). */
  readonly id: string;
  readonly name: string;
  readonly type: SchoolType;
  /** Display board, e.g. "Calgary Board of Education"; the operator for private schools. */
  readonly board: string | null;
  /** Legal school authority as listed by the source. */
  readonly authority: string | null;
  /** Grades as the source states them, e.g. "Elementary/Junior High" or "K-12". */
  readonly grades: string | null;
  readonly programs: readonly SchoolProgram[];
  readonly address: string | null;
  readonly postalCode: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly website: string | null;
  /** True when the school charges tuition (private schools). Never an amount. */
  readonly tuition: boolean;
  /** City community code (e.g. 'ALT') the school sits in, when known. */
  readonly communityCode: string | null;
  readonly communityName: string | null;
  /** Field → the source its value came from (absent when the field is empty). */
  readonly sources: Readonly<Partial<Record<SchoolAttributedField, SchoolSourceId>>>;
  /** When the monthly refresh last wrote or confirmed this school (ISO 8601). */
  readonly refreshedAt: string;
}

/** GET /api/v1/schools?community=&type= */
export interface SchoolsListResponse {
  readonly schools: readonly School[];
  /** Notices for every source that contributed to the returned schools. */
  readonly attributions: readonly SchoolSourceAttribution[];
  /** Copy guard: school details change; confirm with the board. */
  readonly disclaimer: string;
}

/** GET /api/v1/schools/{id} */
export interface SchoolResponse {
  readonly school: School;
  readonly attributions: readonly SchoolSourceAttribution[];
  readonly disclaimer: string;
}
