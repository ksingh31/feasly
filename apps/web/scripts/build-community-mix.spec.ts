import { describe, expect, it, vi } from 'vitest';
import {
  classifyCommunities,
  PROFILE_MULTI_FAMILY_THRESHOLD,
  PROFILE_OVERRIDE_SLUGS,
  type MixCountRow,
} from './build-community-mix.js';

const row = (commName: string, subPropertyUse: string, count: number): MixCountRow => ({
  commName,
  subPropertyUse,
  count,
});

describe('build-community-mix classifyCommunities', () => {
  it('uses the 60% multi-family threshold', () => {
    expect(PROFILE_MULTI_FAMILY_THRESHOLD).toBe(0.6);
  });

  it('classifies a condo-dominated community as profile', () => {
    const rows = [
      row('BELTLINE', 'R110', 28),
      row('BELTLINE', 'R301', 9655),
      row('BELTLINE', 'R201', 663),
    ];
    const [mix] = classifyCommunities(rows, ['beltline']);
    expect(mix.communityType).toBe('profile');
    expect(mix.mix.singleDetached).toBe(28);
    expect(mix.mix.multiFamily).toBe(9655 + 663);
    expect(mix.dwellingUnits).toBe(28 + 9655 + 663);
    expect(mix.mostCommonType).toBe('multiFamily');
  });

  it('classifies a single-detached suburb as build-guide', () => {
    const rows = [row('MAHOGANY', 'R110', 4492), row('MAHOGANY', 'R120', 782), row('MAHOGANY', 'R402', 1938)];
    const [mix] = classifyCommunities(rows, ['mahogany']);
    expect(mix.communityType).toBe('build-guide');
    expect(mix.mix.semiDuplex).toBe(782);
    expect(mix.mostCommonType).toBe('singleDetached');
  });

  it('excludes A-codes (common elements, parking, storage) from dwelling counts', () => {
    const rows = [row('BELTLINE', 'R110', 28), row('BELTLINE', 'A004', 7414), row('BELTLINE', 'A005', 949)];
    const [mix] = classifyCommunities(rows, ['beltline']);
    expect(mix.dwellingUnits).toBe(28);
    expect(mix.mix.multiFamily).toBe(0);
  });

  it('applies the manual override list even below the threshold', () => {
    expect(PROFILE_OVERRIDE_SLUGS).toContain('beltline');
    expect(PROFILE_OVERRIDE_SLUGS).toContain('downtown-commercial-core');
    expect(PROFILE_OVERRIDE_SLUGS).toContain('east-village');
    const rows = [row('DOWNTOWN COMMERCIAL CORE', 'R110', 100), row('DOWNTOWN COMMERCIAL CORE', 'R201', 10)];
    const [mix] = classifyCommunities(rows, ['downtown-commercial-core']);
    expect(mix.communityType).toBe('profile');
  });

  it('defaults to build-guide with a warning when a slug has no dwelling records', () => {
    const onWarn = vi.fn();
    const [mix] = classifyCommunities([], ['ghost-town'], onWarn);
    expect(mix.communityType).toBe('build-guide');
    expect(mix.dwellingUnits).toBe(0);
    expect(onWarn).toHaveBeenCalled();
  });

  it('ignores rows for communities outside the page list', () => {
    const rows = [row('SOMEWHERE ELSE', 'R110', 5000)];
    const mixes = classifyCommunities(rows, ['beltline']);
    expect(mixes).toHaveLength(1);
    expect(mixes[0].dwellingUnits).toBe(0);
  });
});
