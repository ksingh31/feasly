/**
 * School ratings + reviews link (#776) — pure constants and helpers.
 *
 * Shared by the refresh-side builder and the request-side read service, so
 * the read path never imports provider code. Pure — no I/O.
 */
import type { SchoolReviewsLink } from '@feasly/contracts';

/** Kinds of published figure stored per school (one row each). */
export const SCHOOL_RATING_KINDS = ['fraser', 'provincial', 'enrolment'] as const;
export type SchoolRatingKind = (typeof SCHOOL_RATING_KINDS)[number];

/** Attribution shown with every figure of that kind. */
export const SCHOOL_RATING_ATTRIBUTIONS: Readonly<Record<SchoolRatingKind, string>> = {
  fraser: "Fraser Institute — Report Card on Alberta's Schools",
  provincial: 'Alberta Education — provincial achievement test and diploma exam results',
  enrolment: 'Calgary Board of Education — annual school enrolment report',
};

/** Stable record key: one figure of each kind per school. */
export function schoolRatingKey(kind: SchoolRatingKind, schoolId: string): string {
  return `${kind}|${schoolId}`;
}

/** enrolment ÷ capacity as a whole percent. */
export function utilizationPct(enrolment: number, capacity: number): number {
  return Math.round((enrolment / capacity) * 100);
}

/** An absolute https URL, or null. */
export function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** What the free reviews link needs to know about a school. */
export interface ReviewsLinkSchool {
  readonly name: string;
  readonly address: string | null;
}

/** Builds a school's reviews link; null when the reviews provider is off. */
export type SchoolReviewsLinker = (school: ReviewsLinkSchool) => SchoolReviewsLink | null;

export const MAPS_REVIEWS_LABEL = 'Read reviews on Google Maps';

/**
 * Free `maps-link` reviews: a Google Maps search for the school — no API
 * call, nothing fetched or stored. `searchUrl` comes from config.
 */
export function createMapsReviewsLinker(searchUrl: string): SchoolReviewsLinker {
  return (school) => {
    const url = new URL(searchUrl);
    const query = [school.name, school.address, 'Calgary AB'].filter((p) => p && p.trim()).join(', ');
    url.searchParams.set('query', query);
    return { kind: 'link', provider: 'google-maps', label: MAPS_REVIEWS_LABEL, url: url.toString() };
  };
}

/** Reviews provider 'none': no link. */
export const NO_REVIEWS_LINK: SchoolReviewsLinker = () => null;
