import type {
  EstimateInputs,
  NewBuildEstimateRequest,
  PropertyRecord,
} from '@feasly/contracts';

/**
 * Builds the new-build estimate request the live backend expects: the nested
 * `{ property, scope }` shape (mirrors the API's `NewBuildRequestSchema`).
 * A flat body (`addressKey`/`sqft` at top level) gets a 400 from the live API.
 */
export function buildNewBuildRequest(
  property: PropertyRecord,
  inputs: EstimateInputs,
): NewBuildEstimateRequest {
  return {
    projectType: 'new_build',
    property: {
      addressKey: property.addressKey,
      assessedLandValue: property.assessedValue,
      lotSizeSqft: property.lotSqft,
      zoning: property.zoning,
    },
    scope: {
      buildSqft: inputs.sqft,
      tier: inputs.tier,
      garage: inputs.garage,
      basement: inputs.basement,
    },
  };
}
