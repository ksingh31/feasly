import { Injectable } from '@angular/core';

/**
 * Calgary community descriptor for the comparison picker (NBH-04).
 * The picker only needs slugs + display names; per-community cost
 * aggregates stay in `content/data/community-aggregates.json` for the
 * comparison engine (NBH-02).
 */
export interface CommunityDescriptor {
  readonly slug: string;
  readonly name: string;
}

/**
 * Community list (NBH-04): the 40 Calgary communities available for
 * side-by-side comparison, in aggregate-data order (largest first).
 * Static and typed — no API round-trip just to render the picker list.
 */
@Injectable({ providedIn: 'root' })
export class CommunityService {
  private static readonly COMMUNITIES: readonly CommunityDescriptor[] = [
    { slug: 'beltline', name: 'Beltline' },
    { slug: 'panorama-hills', name: 'Panorama Hills' },
    { slug: 'cranston', name: 'Cranston' },
    { slug: 'saddle-ridge', name: 'Saddle Ridge' },
    { slug: 'mckenzie-towne', name: 'McKenzie Towne' },
    { slug: 'evergreen', name: 'Evergreen' },
    { slug: 'mahogany', name: 'Mahogany' },
    { slug: 'tuscany', name: 'Tuscany' },
    { slug: 'sage-hill', name: 'Sage Hill' },
    { slug: 'auburn-bay', name: 'Auburn Bay' },
    { slug: 'skyview-ranch', name: 'Skyview Ranch' },
    { slug: 'evanston', name: 'Evanston' },
    { slug: 'signal-hill', name: 'Signal Hill' },
    { slug: 'copperfield', name: 'Copperfield' },
    { slug: 'legacy', name: 'Legacy' },
    { slug: 'seton', name: 'Seton' },
    { slug: 'varsity', name: 'Varsity' },
    { slug: 'cornerstone', name: 'Cornerstone' },
    { slug: 'springbank-hill', name: 'Springbank Hill' },
    { slug: 'west-springs', name: 'West Springs' },
    { slug: 'douglasdale-glen', name: 'Douglasdale/Glen' },
    { slug: 'coventry-hills', name: 'Coventry Hills' },
    { slug: 'edgemont', name: 'Edgemont' },
    { slug: 'royal-oak', name: 'Royal Oak' },
    { slug: 'lake-bonavista', name: 'Lake Bonavista' },
    { slug: 'huntington-hills', name: 'Huntington Hills' },
    { slug: 'bridlewood', name: 'Bridlewood' },
    { slug: 'mckenzie-lake', name: 'McKenzie Lake' },
    { slug: 'livingston', name: 'Livingston' },
    { slug: 'taradale', name: 'Taradale' },
    { slug: 'downtown-commercial-core', name: 'Downtown Commercial Core' },
    { slug: 'chaparral', name: 'Chaparral' },
    { slug: 'arbour-lake', name: 'Arbour Lake' },
    { slug: 'new-brighton', name: 'New Brighton' },
    { slug: 'beddington-heights', name: 'Beddington Heights' },
    { slug: 'bowness', name: 'Bowness' },
    { slug: 'dover', name: 'Dover' },
    { slug: 'rocky-ridge', name: 'Rocky Ridge' },
    { slug: 'bridgeland-riverside', name: 'Bridgeland/Riverside' },
    { slug: 'walden', name: 'Walden' },
  ];

  /** All communities in display order. */
  list(): readonly CommunityDescriptor[] {
    return CommunityService.COMMUNITIES;
  }

  /** Look up a community by slug (undefined when unknown). */
  bySlug(slug: string): CommunityDescriptor | undefined {
    return CommunityService.COMMUNITIES.find((c) => c.slug === slug);
  }
}
