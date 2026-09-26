/**
 * Nearby-community resolution (SEO-05): each community page links to 3
 * "nearby" communities. Nearby = same City quadrant (best-effort static
 * map); falls back to the 3 highest-record-count communities when the
 * quadrant has fewer than 3 others.
 *
 * The map is static and typed — no API round-trip for a build-time link
 * list. Slugs must match `community-aggregates.json`.
 */

export type Quadrant = 'NW' | 'NE' | 'SW' | 'SE' | 'Central';

/** Static quadrant assignment for the 40 indexed communities. */
const QUADRANT_BY_SLUG: Readonly<Record<string, Quadrant>> = {
  // NW
  'panorama-hills': 'NW',
  tuscany: 'NW',
  'sage-hill': 'NW',
  evanston: 'NW',
  'royal-oak': 'NW',
  'arbour-lake': 'NW',
  'rocky-ridge': 'NW',
  edgemont: 'NW',
  varsity: 'NW',
  bowness: 'NW',
  'beddington-heights': 'NW',
  'huntington-hills': 'NW',
  livingston: 'NW',
  'coventry-hills': 'NW',
  // NE
  'saddle-ridge': 'NE',
  'skyview-ranch': 'NE',
  cornerstone: 'NE',
  taradale: 'NE',
  // SW
  evergreen: 'SW',
  'signal-hill': 'SW',
  'springbank-hill': 'SW',
  'west-springs': 'SW',
  bridlewood: 'SW',
  chaparral: 'SW',
  walden: 'SW',
  legacy: 'SW',
  // SE
  cranston: 'SE',
  'mckenzie-towne': 'SE',
  mahogany: 'SE',
  'auburn-bay': 'SE',
  copperfield: 'SE',
  seton: 'SE',
  'douglasdale-glen': 'SE',
  'mckenzie-lake': 'SE',
  'new-brighton': 'SE',
  dover: 'SE',
  'lake-bonavista': 'SE',
  // Central
  beltline: 'Central',
  'downtown-commercial-core': 'Central',
  'bridgeland-riverside': 'Central',
};

export interface NearbyInput {
  readonly slug: string;
  /** Assessment record count — drives the fallback ordering. */
  readonly count: number;
}

/**
 * Returns up to `n` nearby community slugs for `slug` (default 3).
 * Prefers same-quadrant communities (in input order); fills any shortfall
 * with the highest-record-count communities, excluding `slug` itself.
 * Unknown slugs fall back entirely to the record-count ordering.
 */
export function nearbyCommunities(
  slug: string,
  all: readonly NearbyInput[],
  n = 3,
): readonly string[] {
  const quadrant = QUADRANT_BY_SLUG[slug];
  const others = all.filter((c) => c.slug !== slug);
  const result: string[] = [];

  if (quadrant) {
    for (const c of others) {
      if (result.length >= n) break;
      if (QUADRANT_BY_SLUG[c.slug] === quadrant) {
        result.push(c.slug);
      }
    }
  }

  if (result.length < n) {
    const byCount = [...others].sort((a, b) => b.count - a.count);
    for (const c of byCount) {
      if (result.length >= n) break;
      if (!result.includes(c.slug)) {
        result.push(c.slug);
      }
    }
  }

  return result;
}

/** Quadrant for a slug (undefined when unmapped). */
export function quadrantOf(slug: string): Quadrant | undefined {
  return QUADRANT_BY_SLUG[slug];
}
