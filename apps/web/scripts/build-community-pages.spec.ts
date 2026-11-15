/**
 * #690 spec: which averages each community page type shows.
 */
import { describe, expect, it } from 'vitest';
import { pageAggregate } from './build-community-pages.js';

const ALTADORE = {
  slug: 'altadore',
  name: 'ALTADORE',
  count: 2044,
  avgAssessedValue: 1303428,
  avgLotSqft: 4272,
  basis: 'detached-semi' as const,
  group: 'established' as const,
  sector: 'CENTRE',
  residential: { count: 3100, avgAssessedValue: 980001, avgLotSqft: 8000 },
};

describe('pageAggregate', () => {
  it('guide pages show the single/semi-detached averages only', () => {
    expect(pageAggregate(ALTADORE, 'build-guide')).toEqual({
      slug: 'altadore',
      name: 'ALTADORE',
      count: 2044,
      avgAssessedValue: 1303428,
      avgLotSqft: 4272,
    });
  });

  it('profile pages show the all-residential averages', () => {
    expect(pageAggregate(ALTADORE, 'profile')).toMatchObject({ count: 3100, avgAssessedValue: 980001 });
  });

  it('refuses a guide built on a condo-inclusive average', () => {
    expect(() => pageAggregate({ ...ALTADORE, basis: 'residential' }, 'build-guide')).toThrow(/condo records/);
  });
});
