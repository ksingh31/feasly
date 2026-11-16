import { describe, expect, it } from 'vitest';
import { isRedevelopmentCandidate, propertySteer } from '../src/lib/property-steer';

describe('propertySteer (#755)', () => {
  it('treats a home exactly at the threshold age as a redevelopment candidate', () => {
    expect(propertySteer(2001, 25, 2026)).toEqual({
      redevelopmentCandidate: true,
      reason: 'age_at_or_over_threshold',
      recommendedProjectType: 'new_build',
      homeAgeYears: 25,
      thresholdYears: 25,
    });
  });

  it('steers a home one year under the threshold to renovation', () => {
    const steer = propertySteer(2002, 25, 2026);
    expect(steer.redevelopmentCandidate).toBe(false);
    expect(steer.recommendedProjectType).toBe('renovation');
    expect(steer.homeAgeYears).toBe(24);
  });

  it.each([null, 0, -5, 2030, 1999.5])('does not steer an unknown or implausible year (%s)', (year) => {
    expect(propertySteer(year, 25, 2026)).toEqual({
      redevelopmentCandidate: null,
      reason: 'year_built_unknown',
      recommendedProjectType: null,
      homeAgeYears: null,
      thresholdYears: 25,
    });
  });

  it('exposes the single age rule for other counters (#691)', () => {
    expect(isRedevelopmentCandidate(25, 25)).toBe(true);
    expect(isRedevelopmentCandidate(24, 25)).toBe(false);
  });
});
