import { describe, expect, it } from 'vitest';
import {
  nearbyCommunities,
  quadrantOf,
  type NearbyInput,
} from './nearby-communities';

const ALL: readonly NearbyInput[] = [
  { slug: 'beltline', count: 21589 },
  { slug: 'panorama-hills', count: 18000 },
  { slug: 'tuscany', count: 17000 },
  { slug: 'saddle-ridge', count: 16000 },
  { slug: 'skyview-ranch', count: 15000 },
  { slug: 'evergreen', count: 14000 },
  { slug: 'cranston', count: 13000 },
];

describe('nearbyCommunities', () => {
  it('prefers same-quadrant communities', () => {
    // panorama-hills is NW; tuscany is the only other NW in the fixture.
    const nearby = nearbyCommunities('panorama-hills', ALL, 3);
    expect(nearby[0]).toBe('tuscany');
    expect(nearby).toHaveLength(3);
    expect(nearby).not.toContain('panorama-hills');
  });

  it('fills shortfall with highest-record-count communities', () => {
    // NE has only saddle-ridge + skyview-ranch in the fixture: 1 same-quadrant
    // peer, then the top-count fallback (excluding self).
    const nearby = nearbyCommunities('saddle-ridge', ALL, 3);
    expect(nearby).toContain('skyview-ranch');
    expect(nearby).toHaveLength(3);
    expect(nearby).not.toContain('saddle-ridge');
    // Highest counts first among the fallback picks.
    expect(nearby).toEqual(['skyview-ranch', 'beltline', 'panorama-hills']);
  });

  it('falls back entirely for unknown slugs', () => {
    const nearby = nearbyCommunities('unknown-slug', ALL, 3);
    expect(nearby).toEqual(['beltline', 'panorama-hills', 'tuscany']);
  });

  it('never includes the source slug', () => {
    for (const c of ALL) {
      expect(nearbyCommunities(c.slug, ALL, 3)).not.toContain(c.slug);
    }
  });

  it('respects a custom n', () => {
    expect(nearbyCommunities('beltline', ALL, 2)).toHaveLength(2);
  });
});

describe('quadrantOf', () => {
  it('maps known slugs', () => {
    expect(quadrantOf('beltline')).toBe('Central');
    expect(quadrantOf('tuscany')).toBe('NW');
    expect(quadrantOf('cranston')).toBe('SE');
  });

  it('returns undefined for unknown slugs', () => {
    expect(quadrantOf('nope')).toBeUndefined();
  });
});
