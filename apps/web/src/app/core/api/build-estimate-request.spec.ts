import { describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { buildNewBuildRequest } from './build-estimate-request';

const PROPERTY = {
  addressKey: 'calgary-1234-14-st-nw',
  assessedValue: 729000,
  lotSqft: 5000,
  zoning: 'R-CG',
} as PropertyRecord;

describe('buildNewBuildRequest', () => {
  it('produces the canonical nested new-build request the live API expects', () => {
    const request = buildNewBuildRequest(PROPERTY, {
      sqft: 2400,
      tier: 'premium',
      garage: 'double',
      basement: 'unfinished',
    });

    expect(request).toEqual({
      projectType: 'new_build',
      property: {
        addressKey: 'calgary-1234-14-st-nw',
        assessedLandValue: 729000,
        lotSizeSqft: 5000,
        zoning: 'R-CG',
      },
      scope: {
        buildSqft: 2400,
        tier: 'premium',
        garage: 'double',
        basement: 'unfinished',
      },
    });
  });

  it('maps wizard inputs into scope and city property data into property', () => {
    const request = buildNewBuildRequest(PROPERTY, {
      sqft: 2200,
      tier: 'standard',
      garage: 'none',
      basement: 'finished',
    });

    // Wizard `sqft` becomes scope.buildSqft (the API rejects top-level sqft with 400).
    expect(request.scope.buildSqft).toBe(2200);
    expect(request.scope.tier).toBe('standard');
    // City assessed value is carried verbatim as fixed land input.
    expect(request.property.assessedLandValue).toBe(PROPERTY.assessedValue);
    expect(request.property.lotSizeSqft).toBe(PROPERTY.lotSqft);
  });
});
