/**
 * Shared mock for the CommunityStatsService (NBH-02).
 * Tests that don't exercise the comparison path use this — it returns null
 * for all slugs (comparison is not called in those tests).
 */
import type {
  CommunityStatsService,
  CommunityStatRecord,
} from '../../src/services/community-stats.service';
import type { ComparisonEstimateResponse, EstimateResponse } from '@feasly/contracts';

export function mockCommunityStatsService(): CommunityStatsService {
  return {
    getBySlug: async (_slug: string) => null,
    upsertMany: async (_rows: readonly CommunityStatRecord[]) => 0,
  };
}

/**
 * Narrow the estimate service result to EstimateResponse.
 * Throws if it's a ComparisonEstimateResponse (test bug — the test
 * exercised the comparison path unexpectedly).
 */
export function expectEstimateResponse(
  result: EstimateResponse | ComparisonEstimateResponse,
): EstimateResponse {
  if (result.projectType === 'comparison') {
    throw new Error('Expected EstimateResponse, got ComparisonEstimateResponse');
  }
  return result;
}

/**
 * Narrow the estimate service result to ComparisonEstimateResponse.
 * Throws if it's not a comparison (test bug).
 */
export function expectComparisonResponse(
  result: EstimateResponse | ComparisonEstimateResponse,
): ComparisonEstimateResponse {
  if (result.projectType !== 'comparison') {
    throw new Error('Expected ComparisonEstimateResponse, got EstimateResponse');
  }
  return result as ComparisonEstimateResponse;
}
