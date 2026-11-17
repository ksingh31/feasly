/**
 * Curated school ratings (#776) — the `published-reports` provider's source.
 *
 * None of the sources publishes an open data feed, so this list is
 * transcribed from the published reports, one entry per school and kind:
 * - `fraser`: Fraser Institute "Report Card on Alberta's Schools" overall
 *   rating (out of 10) + report year. Stored and served only when
 *   `NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED=true` (prod stays off until
 *   the owner confirms Fraser's permission).
 * - `provincial`: Alberta Education provincial results (PAT 6 / PAT 9 /
 *   diploma — % acceptable standard, % standard of excellence), where the
 *   school's results are published.
 * - `enrolment`: CBE annual enrolment report — enrolment vs capacity.
 *
 * `schoolId` is the directory id (#774, GET /api/v1/schools/{id});
 * `sourceUrl` is the report it came from. Copy figures exactly as
 * published — never estimate one; a school without an entry shows "n/a".
 *
 * Editing this list is the "refresh": the next monthly run (or admin
 * refresh-now for `school-ratings`) stores it. `NEIGHBOURHOOD_SCHOOL_RATINGS
 * _PROVIDER` stays `none` until the list is filled (an empty list fails the
 * refresh by design).
 */
import type { CuratedSchoolRating } from './school-ratings';

export const PUBLISHED_SCHOOL_RATINGS: readonly CuratedSchoolRating[] = [];
