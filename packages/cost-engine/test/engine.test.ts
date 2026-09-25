/**
 * Formula-correctness tests for the deterministic cost engine.
 *
 * Expected values below are hand-derived from the placeholder data file
 * (v0.2.0-unclibrated) — if the data file changes, these expectations must
 * be re-derived, which is exactly the point: the tests pin the math.
 */
import { describe, expect, it } from 'vitest';
import { createEstimate } from '../src/engine';
import { PLACEHOLDER_COST_DATA } from '../src/cost-data';
import { EngineInputError, type EngineInput } from '../src/types';

const DATA = PLACEHOLDER_COST_DATA;

function standardInput(): EngineInput {
  return {
    property: { assessedLandValue: 300_000, lotSizeSqft: 2_000, zoning: 'R-C1' },
    scope: { buildSqft: 1_000, tier: 'standard' },
  };
}

function rowByKey(result: ReturnType<typeof createEstimate>, key: string) {
  const row = result.rows.find((r) => r.key === key);
  if (!row) throw new Error(`missing row ${key}`);
  return row;
}

describe('createEstimate — formula correctness (placeholder data)', () => {
  const result = createEstimate(standardInput(), DATA);

  it('emits one land row plus one row per hard/soft category plus contingency', () => {
    // 1 land + 6 hard + 2 soft + 1 contingency
    expect(result.rows).toHaveLength(10);
    expect(result.rows[0]?.key).toBe('land');
    expect(result.rows[result.rows.length - 1]?.key).toBe('contingency');
  });

  it('prices land as the fixed assessed value — no spread', () => {
    // 300000 fixed: the breakdown row carries a degenerate range, and the
    // top-level land figure is a single fixed amount.
    expect(rowByKey(result, 'land').range).toEqual({ low: 300_000, base: 300_000, high: 300_000 });
    expect(result.totals.land).toEqual({ value: 300_000 });
  });

  it('scales lot-based categories by lot size', () => {
    // sitePrep: 2000 sqft × 4 × (1 ± 0.20)
    expect(rowByKey(result, 'hard.sitePrep').range).toEqual({ low: 6_400, base: 8_000, high: 9_600 });
  });

  it('scales build-based categories by build sqft and tier rate', () => {
    // foundation: 1000 × 28 ± 12% → 28000 × 0.88 = 24640, × 1.12 = 31360
    expect(rowByKey(result, 'hard.foundation').range).toEqual({
      low: 24_640,
      base: 28_000,
      high: 31_360,
    });
    // finishes: 1000 × 55 ± 18% → 45100 / 64900
    expect(rowByKey(result, 'hard.finishes').range).toEqual({
      low: 45_100,
      base: 55_000,
      high: 64_900,
    });
  });

  it('derives soft costs from the hard-cost base total', () => {
    // hard base = 8000+28000+38000+32000+30000+55000 = 191000
    // design: 191000 × 0.06 = 11460 ± 20% → 9168 / 13752
    expect(rowByKey(result, 'soft.design').range).toEqual({
      low: 9_168,
      base: 11_460,
      high: 13_752,
    });
    // permits: 191000 × 0.015 = 2865 ± 25% → round(2148.75)=2149 / round(3581.25)=3581
    expect(rowByKey(result, 'soft.permits').range).toEqual({
      low: 2_149,
      base: 2_865,
      high: 3_581,
    });
  });

  it('derives contingency from hard + soft base', () => {
    // (191000 + 14325) × 0.10 = 20532.5 → 20533, spread 0 → flat band
    expect(rowByKey(result, 'contingency').range).toEqual({
      low: 20_533,
      base: 20_533,
      high: 20_533,
    });
  });

  it('rolls rows up into build / land / total', () => {
    // build base = 191000 + 14325 + 20533 = 225858
    expect(result.totals.build.base).toBe(225_858);
    expect(result.totals.land.value).toBe(300_000);
    expect(result.totals.total.base).toBe(525_858);
    // totals are the sums of the row bands
    const sumBase = result.rows.reduce((acc, row) => acc + row.range.base, 0);
    const sumLow = result.rows.reduce((acc, row) => acc + row.range.low, 0);
    const sumHigh = result.rows.reduce((acc, row) => acc + row.range.high, 0);
    expect(result.totals.total.base).toBe(sumBase);
    expect(result.totals.total.low).toBe(sumLow);
    expect(result.totals.total.high).toBe(sumHigh);
  });

  it('prices tiers monotonically (luxury >= premium >= standard)', () => {
    const totals = (['standard', 'premium', 'luxury'] as const).map(
      (tier) => createEstimate({ ...standardInput(), scope: { buildSqft: 1_000, tier } }, DATA).totals.total.base,
    );
    expect(totals[0]).toBeLessThanOrEqual(totals[1]!);
    expect(totals[1]).toBeLessThanOrEqual(totals[2]!);
    expect(totals[0]).toBeLessThan(totals[2]!);
  });
});

describe('createEstimate — range ordering', () => {
  for (const tier of ['standard', 'premium', 'luxury'] as const) {
    it(`low <= base <= high on every row and total (${tier})`, () => {
      const result = createEstimate(
        { ...standardInput(), scope: { buildSqft: 2_400, tier } },
        DATA,
      );
      for (const row of result.rows) {
        expect(row.range.low).toBeLessThanOrEqual(row.range.base);
        expect(row.range.base).toBeLessThanOrEqual(row.range.high);
      }
      for (const total of [result.totals.build, result.totals.total]) {
        expect(total.low).toBeLessThanOrEqual(total.base);
        expect(total.base).toBeLessThanOrEqual(total.high);
      }
      // Land is a fixed figure, not a range — it equals the assessed value.
      expect(result.totals.land.value).toBe(300_000);
    });
  }
});

describe('createEstimate — determinism', () => {
  it('same input + same data version = byte-identical output', () => {
    const first = JSON.stringify(createEstimate(standardInput(), DATA));
    const second = JSON.stringify(createEstimate(standardInput(), DATA));
    expect(second).toBe(first);
  });

  it('is stable across JSON round-trips (no hidden float drift)', () => {
    const result = createEstimate(standardInput(), DATA);
    const revived = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(JSON.stringify(revived)).toBe(JSON.stringify(result));
  });
});

describe('createEstimate — version pin', () => {
  it('pins the cost-data version and calibration flag on every estimate', () => {
    const result = createEstimate(standardInput(), DATA);
    expect(result.costDataVersion).toBe(DATA.version);
    expect(result.costDataVersion).toBe('v0.2.0-unclibrated');
    expect(result.calibrated).toBe(false);
  });
});

describe('createEstimate — invalid input rejection', () => {
  const cases: Array<[string, EngineInput]> = [
    ['zero build sqft', { ...standardInput(), scope: { buildSqft: 0, tier: 'standard' } }],
    ['oversized build', { ...standardInput(), scope: { buildSqft: 99_999, tier: 'standard' } }],
    ['undersized lot', { ...standardInput(), property: { assessedLandValue: 300_000, lotSizeSqft: 500, zoning: 'R-C1' } }],
    ['tiny assessed value', { ...standardInput(), property: { assessedLandValue: 1_000, lotSizeSqft: 2_000, zoning: 'R-C1' } }],
    ['blank zoning', { ...standardInput(), property: { assessedLandValue: 300_000, lotSizeSqft: 2_000, zoning: '  ' } }],
    ['unknown tier', { ...standardInput(), scope: { buildSqft: 1_000, tier: 'ultra' as 'standard' } }],
  ];

  for (const [name, input] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => createEstimate(input, DATA)).toThrow(EngineInputError);
    });
  }
});
