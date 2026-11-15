/**
 * Formula-correctness tests for the deterministic cost engine.
 *
 * The exact-figure expectations below are hand-derived from the previous
 * placeholder table (v0.3.0-unclibrated, whole-dollar output). They stay
 * pinned to v0.3.0 on purpose: an estimate under an older cost_data_version
 * must stay byte-identical after the engine learns `roundTo` (#581). The
 * current table (v0.4.0) is covered by the "output rounding" block.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEstimate } from '../src/engine';
import { createComparisonEstimate } from '../src/comparison';
import { COST_DATA_V0_3_0, PLACEHOLDER_COST_DATA } from '../src/cost-data';
import { EngineInputError, type ComparisonInput, type EngineInput } from '../src/types';

/** Whole-dollar table: the pinned exact figures below must never move. */
const DATA = COST_DATA_V0_3_0;
/** Current table: same rates as v0.3.0 plus roundTo = 1000. */
const CURRENT = PLACEHOLDER_COST_DATA;

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
    const result = createEstimate(standardInput(), CURRENT);
    expect(result.costDataVersion).toBe(CURRENT.version);
    expect(result.costDataVersion).toBe('v0.4.0-unclibrated');
    expect(result.calibrated).toBe(false);
    expect(createEstimate(standardInput(), DATA).costDataVersion).toBe('v0.3.0-unclibrated');
  });
});

describe('older version stays byte-identical (#581)', () => {
  // Captured from origin/main's engine before roundTo existed. Any diff
  // here means a stored v0.3.0 estimate would no longer reproduce.
  const golden = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'v0.3.0-golden.json'), 'utf8'),
  ) as {
    costDataVersion: string;
    estimates: Array<{ input: EngineInput; output: unknown }>;
    comparisons: Array<{ input: ComparisonInput; output: unknown }>;
  };

  it('the golden is for v0.3.0, which publishes no top-level roundTo', () => {
    expect(golden.costDataVersion).toBe(DATA.version);
    expect(DATA.roundTo).toBeUndefined();
    expect(golden.estimates.length).toBeGreaterThan(0);
  });

  it('createEstimate under v0.3.0 matches the pre-#581 output byte-for-byte', () => {
    for (const { input, output } of golden.estimates) {
      expect(JSON.stringify(createEstimate(input, DATA))).toBe(JSON.stringify(output));
    }
  });

  it('createComparisonEstimate under v0.3.0 matches the pre-#581 output byte-for-byte', () => {
    for (const { input, output } of golden.comparisons) {
      expect(JSON.stringify(createComparisonEstimate(input, DATA))).toBe(JSON.stringify(output));
    }
  });

  it('the worked example totals are unchanged under v0.3.0', () => {
    expect(JSON.stringify(createEstimate(standardInput(), DATA).totals)).toBe(
      JSON.stringify({
        build: { low: 194_130, base: 225_858, high: 257_586 },
        land: { value: 300_000 },
        total: { low: 494_130, base: 525_858, high: 557_586 },
      }),
    );
  });
});

describe('createEstimate — output rounding (v0.4.0, roundTo from cost data)', () => {
  const g = CURRENT.roundTo!;

  it('the current table publishes a $1,000 output granularity', () => {
    expect(g).toBe(1_000);
  });

  it('rounds the worked example to the nearest $1,000', () => {
    const result = createEstimate(standardInput(), CURRENT);
    // sitePrep 8000 ± 20% → 6400/9600 → 6000/10000
    expect(rowByKey(result, 'hard.sitePrep').range).toEqual({ low: 6_000, base: 8_000, high: 10_000 });
    // permits: hard base 191000 × 0.015 = 2865 → 3000 ± 25% → 2250/3750 → 2000/4000
    expect(rowByKey(result, 'soft.permits').range).toEqual({ low: 2_000, base: 3_000, high: 4_000 });
    // Land is the City fact — exact, never rounded.
    expect(rowByKey(result, 'land').range).toEqual({ low: 300_000, base: 300_000, high: 300_000 });
    expect(result.totals.land).toEqual({ value: 300_000 });
  });

  const sizes = [400, 999, 1_000, 1_234, 1_837, 2_400, 3_001, 4_567, 7_777, 12_000];
  const lots = [1_200, 2_000, 3_333, 6_123, 20_000];
  const lands = [25_000, 300_000, 487_321, 1_234_567];

  for (const tier of ['standard', 'premium', 'luxury'] as const) {
    it(`every build band leaf is a multiple of roundTo and totals stay consistent (${tier})`, () => {
      for (const buildSqft of sizes) {
        for (const lotSizeSqft of lots) {
          for (const assessedLandValue of lands) {
            const result = createEstimate(
              { property: { assessedLandValue, lotSizeSqft, zoning: 'R-C1' }, scope: { buildSqft, tier } },
              CURRENT,
            );
            for (const row of result.rows) {
              if (row.key === 'land') continue;
              for (const leaf of [row.range.low, row.range.base, row.range.high]) {
                expect(leaf % g).toBe(0);
              }
              expect(row.range.low).toBeLessThanOrEqual(row.range.base);
              expect(row.range.base).toBeLessThanOrEqual(row.range.high);
            }
            const { build, land, total } = result.totals;
            for (const leaf of [build.low, build.base, build.high]) expect(leaf % g).toBe(0);
            // total === land + build stays exact (land carried to the dollar).
            expect(total).toEqual({
              low: land.value + build.low,
              base: land.value + build.base,
              high: land.value + build.high,
            });
            expect(land.value).toBe(assessedLandValue);
            // Build total = sum of the non-land rows.
            const buildRows = result.rows.filter((r) => r.key !== 'land');
            expect(buildRows.reduce((a, r) => a + r.range.base, 0)).toBe(build.base);
            expect(buildRows.reduce((a, r) => a + r.range.low, 0)).toBe(build.low);
            expect(buildRows.reduce((a, r) => a + r.range.high, 0)).toBe(build.high);
          }
        }
      }
    });
  }

  it('is deterministic under the rounding table', () => {
    expect(JSON.stringify(createEstimate(standardInput(), CURRENT))).toBe(
      JSON.stringify(createEstimate(standardInput(), CURRENT)),
    );
  });
});

describe('createEstimate — invalid input rejection', () => {
  const cases: Array<[string, EngineInput]> = [
    ['zero build sqft', { ...standardInput(), scope: { buildSqft: 0, tier: 'standard' } }],
    ['oversized build', { ...standardInput(), scope: { buildSqft: 99_999, tier: 'standard' } }],
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
