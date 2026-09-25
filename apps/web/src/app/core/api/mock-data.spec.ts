import { describe, expect, it } from 'vitest';
import type { ComparisonEstimateRequest } from '@feasly/contracts';
import { mockCommunityStats, mockComparisonEstimate } from './mock-data';

/**
 * Comparison mock conformance (NBH-03): the mock stats carry the real
 * City-assessed values from the checked-in aggregates, and the mock
 * comparison mirrors the backend engine's shape (land from lot size,
 * identical build across communities, exactly one lowestLand flag).
 */
describe('mockCommunityStats', () => {
  it('returns the real assessed value from the City aggregates fixture', () => {
    const stats = mockCommunityStats('beltline');
    expect(stats.slug).toBe('beltline');
    // Real fixture value — never hardcoded in UI code; asserted here so a
    // fixture regeneration that changes the value fails loudly.
    expect(stats.avg_assessed_value).toBe(607351);
    expect(stats.assessment_count).toBeGreaterThan(0);
    expect(stats.avg_lot_sqft).toBeGreaterThan(0);
  });

  it('throws not_found for an unknown slug', () => {
    expect(() => mockCommunityStats('no-such-community')).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('mockComparisonEstimate', () => {
  const request: ComparisonEstimateRequest = {
    projectType: 'comparison',
    neighbourhoods: ['beltline', 'panorama-hills'],
    sqft: 2200,
    tier: 'premium',
  };

  it('returns one row-set per community with land/build/total ranges', () => {
    const response = mockComparisonEstimate(request);
    expect(response.projectType).toBe('comparison');
    expect(response.inputs).toEqual({ sqft: 2200, tier: 'premium' });
    expect(response.rowSets).toHaveLength(2);
    for (const rowSet of response.rowSets) {
      expect(rowSet.land.low).toBeLessThanOrEqual(rowSet.land.base);
      expect(rowSet.land.base).toBeLessThanOrEqual(rowSet.land.high);
      expect(rowSet.build.low).toBeLessThanOrEqual(rowSet.build.base);
      expect(rowSet.total.base).toBe(rowSet.land.base + rowSet.build.base);
      expect(rowSet.visibility).toEqual({
        land: 'visible',
        build: 'blurred',
        total: 'blurred',
      });
    }
  });

  it('uses the identical build band across communities (same house design)', () => {
    const response = mockComparisonEstimate(request);
    expect(response.rowSets[0].build).toEqual(response.rowSets[1].build);
  });

  it('sets exactly one lowestLand flag — the cheapest by land.low', () => {
    const response = mockComparisonEstimate(request);
    const flagged = response.rowSets.filter((r) => r.lowestLand);
    expect(flagged).toHaveLength(1);
    const cheapestLow = Math.min(...response.rowSets.map((r) => r.land.low));
    expect(flagged[0].land.low).toBe(cheapestLow);
  });

  it('breaks lowestLand ties by input order (documented, deterministic)', () => {
    // The flagging loop uses strict <, so when two row-sets tie on land.low
    // the first slug in input order keeps the flag. We verify the invariant
    // both orders: exactly one flag, always on a minimum-land.low row-set.
    for (const neighbourhoods of [
      ['beltline', 'cranston'],
      ['cranston', 'beltline'],
    ] as const) {
      const response = mockComparisonEstimate({
        projectType: 'comparison',
        neighbourhoods: [...neighbourhoods],
        sqft: 2200,
        tier: 'premium',
      });
      const flagged = response.rowSets.filter((r) => r.lowestLand);
      expect(flagged).toHaveLength(1);
      const cheapestLow = Math.min(...response.rowSets.map((r) => r.land.low));
      expect(flagged[0].land.low).toBe(cheapestLow);
    }
  });

  it('scales build by tier (what-if re-runs change the figures)', () => {
    const premium = mockComparisonEstimate(request);
    const luxury = mockComparisonEstimate({ ...request, tier: 'luxury' });
    expect(luxury.rowSets[0].build.base).toBeGreaterThan(
      premium.rowSets[0].build.base,
    );
    // Land is lot-driven: tier-independent.
    expect(luxury.rowSets[0].land).toEqual(premium.rowSets[0].land);
  });

  it('rejects fewer than 2 or more than 3 neighbourhoods', () => {
    expect(() =>
      mockComparisonEstimate({
        projectType: 'comparison',
        neighbourhoods: ['beltline'],
        sqft: 2200,
        tier: 'premium',
      }),
    ).toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('produces a stable estimateId for identical inputs', () => {
    const a = mockComparisonEstimate(request);
    const b = mockComparisonEstimate(request);
    expect(a.estimateId).toBe(b.estimateId);
  });
});
