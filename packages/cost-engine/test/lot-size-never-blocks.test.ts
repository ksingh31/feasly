/**
 * Lot size NEVER blocks pricing (Karan, 2026-09-28).
 *
 * Regression: entering "1234 11 Av SW, Calgary" (lot 21,577 sq ft) hit a
 * "We can't price this property yet" dead-end because the lot sat outside
 * the 1,200–20,000 sq ft inputBounds the engine enforced. Karan's directive:
 * NEVER block the estimator on lot size — quote off the house size.
 * Bigger-lot adjustments (possible +10% uplift, "landscaping excluded"
 * note) are deferred to cost-sheet calibration time, not the estimator.
 */
import { describe, expect, it } from 'vitest';
import { createEstimate } from '../src/engine';
import { PLACEHOLDER_COST_DATA } from '../src/cost-data';
import { EngineInputError, type EngineInput } from '../src/types';

const DATA = PLACEHOLDER_COST_DATA;

function inputWithLot(lotSizeSqft: number): EngineInput {
  return {
    property: { assessedLandValue: 729_000, lotSizeSqft, zoning: 'R-CG' },
    scope: { buildSqft: 2_200, tier: 'standard' },
  };
}

describe('lot size never blocks pricing', () => {
  it("prices Karan's 21,577 sq ft lot (1234 11 Av SW, Calgary)", () => {
    const result = createEstimate(inputWithLot(21_577), DATA);
    expect(result.totals.build.base).toBeGreaterThan(0);
    expect(result.totals.total.base).toBeGreaterThan(0);
  });

  it('prices lots far outside the old 1,200–20,000 bounds', () => {
    for (const lot of [500, 1_199, 20_001, 100_000, 643_811]) {
      const result = createEstimate(inputWithLot(lot), DATA);
      expect(result.totals.build.base).toBeGreaterThan(0);
      expect(result.totals.total.base).toBeGreaterThan(0);
    }
  });

  it('still rejects a non-finite lot size (missing/corrupt data cannot price)', () => {
    expect(() => createEstimate(inputWithLot(NaN), DATA)).toThrow(EngineInputError);
  });
});
