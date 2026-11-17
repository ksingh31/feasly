/**
 * Curated CBE + CCSD school designations (#775) — the `board-published`
 * provider's source.
 *
 * Both boards publish designations by community (designation maps and
 * notices on their sites) with no open boundary file, so this list is
 * transcribed from those notices: one entry per established community
 * (#690), board and grade band (K-6 or K-9, 7-9, 10-12). Set `sourceUrl` to
 * the notice and `schoolYear` to the year it covers.
 *
 * Editing this list is the "refresh": the next monthly run stores it, and
 * any designation that differs from the stored one opens one GitHub review
 * issue. `NEIGHBOURHOOD_SCHOOL_DESIGNATION_PROVIDER` stays `none` until the
 * list is filled (an empty list fails the refresh by design).
 */
import type { CuratedDesignation } from './school-designations';

export const BOARD_PUBLISHED_DESIGNATIONS: readonly CuratedDesignation[] = [];
