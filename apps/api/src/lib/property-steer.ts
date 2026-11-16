/**
 * Project-type steer by home age (#755, owner decision 2026-11-15).
 *
 * - Homes `thresholdYears` or older (by the City's year of construction) are
 *   redevelopment candidates → new build is offered first.
 * - Younger homes are steered to renovation (offered first); the client
 *   still lets the user continue with a new build (the override).
 * - Renovation is offered at any age.
 * - Unknown (or implausible) year built → no steering.
 *
 * Pure: the threshold comes from market config (`propertyData.
 * redevelopmentMinAgeYears`) and the year from the caller's clock, so the
 * community lot inventory (#691/#693) can count candidates with the same rule.
 */
import type { PropertySteer } from '@feasly/contracts';

export function propertySteer(
  yearBuilt: number | null,
  thresholdYears: number,
  currentYear: number,
): PropertySteer {
  const known =
    yearBuilt !== null && Number.isInteger(yearBuilt) && yearBuilt > 0 && yearBuilt <= currentYear;
  if (!known) {
    return {
      redevelopmentCandidate: null,
      reason: 'year_built_unknown',
      recommendedProjectType: null,
      homeAgeYears: null,
      thresholdYears,
    };
  }
  const homeAgeYears = currentYear - yearBuilt;
  const candidate = isRedevelopmentCandidate(homeAgeYears, thresholdYears);
  return {
    redevelopmentCandidate: candidate,
    reason: candidate ? 'age_at_or_over_threshold' : 'age_under_threshold',
    recommendedProjectType: candidate ? 'new_build' : 'renovation',
    homeAgeYears,
    thresholdYears,
  };
}

/** The single age rule: at or over the threshold is a candidate. */
export function isRedevelopmentCandidate(homeAgeYears: number, thresholdYears: number): boolean {
  return homeAgeYears >= thresholdYears;
}
