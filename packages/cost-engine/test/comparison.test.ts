/**
 * Tests for the neighbourhood comparison engine branch (NBH-02).
 */
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_COST_DATA } from '../src/cost-data';
import { createComparisonEstimate } from '../src/comparison';
import { EngineInputError } from '../src/types';

const TIER = 'standard' as const;

describe('createComparisonEstimate', () => {
  it('returns 2 row-sets for 2 neighbourhoods with exactly one lowestLand', () => {
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['community-a', 'community-b'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: {
          'community-a': 5000,
          'community-b': 6000,
        },
        assessedValueBySlug: {
          'community-a': 500000,
          'community-b': 600000,
        },
      },
      PLACEHOLDER_COST_DATA,
    );

    expect(result.rowSets).toHaveLength(2);
    expect(result.costDataVersion).toBe('v0.3.0-unclibrated');

    // Exactly one has lowestLand: true (community-a has the lower assessed value)
    const lowest = result.rowSets.filter((rs) => rs.lowestLand);
    expect(lowest).toHaveLength(1);
    expect(lowest[0].slug).toBe('community-a');
  });

  it('returns 3 row-sets for 3 neighbourhoods', () => {
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['a', 'b', 'c'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: { a: 5000, b: 6000, c: 5500 },
        assessedValueBySlug: { a: 500000, b: 600000, c: 550000 },
      },
      PLACEHOLDER_COST_DATA,
    );

    expect(result.rowSets).toHaveLength(3);
    const lowest = result.rowSets.filter((rs) => rs.lowestLand);
    expect(lowest).toHaveLength(1);
    expect(lowest[0].slug).toBe('a'); // smallest lot
  });

  it('flags the cheapest land by assessed value (not modelled land)', () => {
    // Use lot sizes that produce different modelled land lows
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['expensive', 'cheap'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: {
          expensive: 10000, // bigger lot → higher modelled land
          cheap: 4000, // smaller lot → lower modelled land
        },
        assessedValueBySlug: {
          expensive: 800000,
          cheap: 300000,
        },
      },
      PLACEHOLDER_COST_DATA,
    );

    const cheap = result.rowSets.find((rs) => rs.slug === 'cheap')!;
    const expensive = result.rowSets.find((rs) => rs.slug === 'expensive')!;
    expect(cheap.lowestLand).toBe(true);
    expect(expensive.lowestLand).toBe(false);
    expect(cheap.land.low).toBeLessThan(expensive.land.low);
  });

  it('flags the badge by assessed value when modelled land disagrees (Beltline/Panorama regression)', () => {
    // Reported bug: Beltline got the "Lowest land cost" badge because its
    // smaller lot produced a cheaper *modelled* land band, while Panorama
    // Hills had the lower City-assessed value — the figure the page shows.
    // The badge must follow the displayed assessed value.
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['beltline-like', 'panorama-like'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: {
          'beltline-like': 4000, // smaller lot → cheaper modelled land.low
          'panorama-like': 6000,
        },
        assessedValueBySlug: {
          'beltline-like': 898964, // higher assessed value…
          'panorama-like': 785312, // …but the lower one — badge goes here
        },
      },
      PLACEHOLDER_COST_DATA,
    );

    const beltline = result.rowSets.find((rs) => rs.slug === 'beltline-like')!;
    const panorama = result.rowSets.find((rs) => rs.slug === 'panorama-like')!;
    expect(beltline.land.low).toBeLessThan(panorama.land.low); // modelled order disagrees…
    expect(panorama.lowestLand).toBe(true); // …but the badge follows assessed
    expect(beltline.lowestLand).toBe(false);
    const lowest = result.rowSets.filter((rs) => rs.lowestLand);
    expect(lowest).toHaveLength(1);
  });

  it('tie on assessed value goes to the first slug (deterministic)', () => {
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['first', 'second'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: {
          first: 5000,
          second: 6000, // different lot sizes…
        },
        assessedValueBySlug: {
          first: 500000,
          second: 500000, // …same assessed value → tie
        },
      },
      PLACEHOLDER_COST_DATA,
    );

    const first = result.rowSets.find((rs) => rs.slug === 'first')!;
    const second = result.rowSets.find((rs) => rs.slug === 'second')!;
    expect(first.lowestLand).toBe(true);
    expect(second.lowestLand).toBe(false);
  });

  it('componentwise sums hold: total = land + build', () => {
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['a', 'b'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: { a: 5000, b: 6000 },
        assessedValueBySlug: { a: 500000, b: 600000 },
      },
      PLACEHOLDER_COST_DATA,
    );

    for (const rs of result.rowSets) {
      expect(rs.total.low).toBe(rs.land.low + rs.build.low);
      expect(rs.total.base).toBe(rs.land.base + rs.build.base);
      expect(rs.total.high).toBe(rs.land.high + rs.build.high);
    }
  });

  it('land uses avgLotSqft × landRatePerSqft ± landSpread', () => {
    const avgLotSqft = 5000;
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['a', 'b'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: { a: avgLotSqft, b: 6000 },
        assessedValueBySlug: { a: 500000, b: 600000 },
      },
      PLACEHOLDER_COST_DATA,
    );

    const rs = result.rowSets.find((r) => r.slug === 'a')!;
    const expectedBase = Math.round(avgLotSqft * PLACEHOLDER_COST_DATA.comparison.landRatePerSqft);
    const spread = PLACEHOLDER_COST_DATA.comparison.landSpread;
    
    expect(rs.land.base).toBe(expectedBase);
    expect(rs.land.low).toBe(Math.round(expectedBase * (1 - spread)));
    expect(rs.land.high).toBe(Math.round(expectedBase * (1 + spread)));
  });

  it('visibility hints: land visible, build/total blurred', () => {
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['a', 'b'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: { a: 5000, b: 6000 },
        assessedValueBySlug: { a: 500000, b: 600000 },
      },
      PLACEHOLDER_COST_DATA,
    );

    for (const rs of result.rowSets) {
      expect(rs.visibility).toEqual({
        land: 'visible',
        build: 'blurred',
        total: 'blurred',
      });
    }
  });

  it('rejects < 2 neighbourhoods', () => {
    expect(() =>
      createComparisonEstimate(
        {
          neighbourhoods: ['only-one'],
          buildSqft: 2000,
          tier: TIER,
          avgLotSqftBySlug: { 'only-one': 5000 },
          assessedValueBySlug: { 'only-one': 500000 },
        },
        PLACEHOLDER_COST_DATA,
      ),
    ).toThrow(EngineInputError);
  });

  it('rejects > 3 neighbourhoods', () => {
    expect(() =>
      createComparisonEstimate(
        {
          neighbourhoods: ['a', 'b', 'c', 'd'],
          buildSqft: 2000,
          tier: TIER,
          avgLotSqftBySlug: { a: 5000, b: 6000, c: 5500, d: 5200 },
          assessedValueBySlug: { a: 500000, b: 600000, c: 550000, d: 520000 },
        },
        PLACEHOLDER_COST_DATA,
      ),
    ).toThrow(EngineInputError);
  });

  it('rejects null avgLotSqft', () => {
    expect(() =>
      createComparisonEstimate(
        {
          neighbourhoods: ['a', 'b'],
          buildSqft: 2000,
          tier: TIER,
          avgLotSqftBySlug: { a: 5000, b: null },
          assessedValueBySlug: { a: 500000, b: 600000 },
        },
        PLACEHOLDER_COST_DATA,
      ),
    ).toThrow(EngineInputError);
  });

  it('rejects null assessed value', () => {
    expect(() =>
      createComparisonEstimate(
        {
          neighbourhoods: ['a', 'b'],
          buildSqft: 2000,
          tier: TIER,
          avgLotSqftBySlug: { a: 5000, b: 6000 },
          assessedValueBySlug: { a: 500000, b: null },
        },
        PLACEHOLDER_COST_DATA,
      ),
    ).toThrow(EngineInputError);
  });

  it('rejects unknown tier', () => {
    expect(() =>
      createComparisonEstimate(
        {
          neighbourhoods: ['a', 'b'],
          buildSqft: 2000,
          tier: 'ultra' as any,
          avgLotSqftBySlug: { a: 5000, b: 6000 },
          assessedValueBySlug: { a: 500000, b: 600000 },
        },
        PLACEHOLDER_COST_DATA,
      ),
    ).toThrow(EngineInputError);
  });

  it('output contains no per-sqft rates or margins (deny-list)', () => {
    const result = createComparisonEstimate(
      {
        neighbourhoods: ['a', 'b'],
        buildSqft: 2000,
        tier: TIER,
        avgLotSqftBySlug: { a: 5000, b: 6000 },
        assessedValueBySlug: { a: 500000, b: 600000 },
      },
      PLACEHOLDER_COST_DATA,
    );

    const json = JSON.stringify(result);
    // No per-sqft rates leaked
    expect(json).not.toMatch(/per.?sqft/i);
    expect(json).not.toMatch(/landRatePerSqft/);
    // No margin percentages
    expect(json).not.toMatch(/margin/i);
  });
});
