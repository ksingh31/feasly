import { describe, expect, it } from 'vitest';
import type { CommunityIndexEntry } from '@feasly/contracts';
import { CommunitySearchService, establishedCommunities, matchCommunities } from './community-search';

const list = [
  { slug: 'sunalta', name: 'Sunalta' },
  { slug: 'altadore', name: 'Altadore' },
  { slug: 'scarboro-sunalta-west', name: 'Scarboro/Sunalta West' },
  { slug: 'bowness', name: 'Bowness' },
  { slug: 'west-hillhurst', name: 'West Hillhurst' },
];

describe('matchCommunities (#783)', () => {
  it('puts names starting with the query first, then word starts, then substrings', () => {
    expect(matchCommunities('alta', list, 10).map((c) => c.slug)).toEqual([
      'altadore',
      'scarboro-sunalta-west',
      'sunalta',
    ]);
    expect(matchCommunities('west', list, 10).map((c) => c.slug)).toEqual([
      'west-hillhurst',
      'scarboro-sunalta-west',
    ]);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(matchCommunities('  ALTA ', list, 10)[0]?.slug).toBe('altadore');
    expect(matchCommunities('scarboro sunalta', list, 10).map((c) => c.slug)).toEqual([
      'scarboro-sunalta-west',
    ]);
  });

  it('respects the limit and returns nothing for blank queries', () => {
    expect(matchCommunities('alta', list, 1)).toHaveLength(1);
    expect(matchCommunities('   ', list, 10)).toEqual([]);
    expect(matchCommunities('alta', list, 0)).toEqual([]);
  });

  it('returns nothing for a street address', () => {
    expect(matchCommunities('1412 prospect', list, 10)).toEqual([]);
  });
});

describe('establishedCommunities (#690 rule)', () => {
  it('keeps established communities only, with display names', () => {
    const entries = [
      { slug: 'altadore', name: 'ALTADORE', group: 'established' },
      { slug: 'mahogany', name: 'MAHOGANY', group: 'newer' },
    ] as unknown as CommunityIndexEntry[];
    expect(establishedCommunities(entries)).toEqual([{ slug: 'altadore', name: 'Altadore' }]);
  });
});

describe('CommunitySearchService', () => {
  it('finds Altadore in the bundled community index', () => {
    const results = new CommunitySearchService().search('alta', 4);
    expect(results[0]).toEqual({ slug: 'altadore', name: 'Altadore' });
    expect(results.every((c) => c.slug !== 'mahogany')).toBe(true);
  });
});
