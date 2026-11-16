import type {
  EstimateInputs,
  NewBuildEstimateRequest,
  PropertyRecord,
} from '@feasly/contracts';

/**
 * Builds the new-build estimate request the live backend expects: the nested
 * `{ property, scope }` shape (mirrors the API's `NewBuildRequestSchema`).
 * A flat body (`addressKey`/`sqft` at top level) gets a 400 from the live API.
 * #689: `inputs.buildingForm` rides along as `scope.buildingForm` when set.
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
      // #689: only when the scope step chose one — omitted = single-detached,
      // byte-identical to the request before building forms existed.
      ...(inputs.buildingForm !== undefined ? { buildingForm: inputs.buildingForm } : {}),
    },
  };
}
