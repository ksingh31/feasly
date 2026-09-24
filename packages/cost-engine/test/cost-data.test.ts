/**
 * Calibration-table integrity tests. The placeholder table is explicitly
 * uncalibrated — these tests pin that fact and guard the table's shape so
 * a malformed future version fails loudly at load time, not mid-estimate.
 */
import { describe, expect, it } from 'vitest';
import { assertValidCostData, PLACEHOLDER_COST_DATA } from '../src/cost-data';

describe('placeholder cost-data table', () => {
  it('is versioned and explicitly marked uncalibrated', () => {
    expect(PLACEHOLDER_COST_DATA.version).toBe('v0.1.0-unclibrated');
    expect(PLACEHOLDER_COST_DATA.calibrated).toBe(false);
    expect(PLACEHOLDER_COST_DATA.source).toBe('placeholder');
  });

  it('carries the do-not-ship warning', () => {
    expect(PLACEHOLDER_COST_DATA._comment).toMatch(/PLACEHOLDER/i);
    expect(PLACEHOLDER_COST_DATA.notes).toMatch(/stand-in/i);
  });

  it('passes its own shape validation', () => {
    expect(() => assertValidCostData(PLACEHOLDER_COST_DATA)).not.toThrow();
  });

  it('has positive rates and sane spreads/fractions', () => {
    for (const category of Object.values(PLACEHOLDER_COST_DATA.hardCosts)) {
      for (const rate of Object.values(category.rates)) {
        expect(rate).toBeGreaterThan(0);
      }
      expect(category.spread).toBeGreaterThanOrEqual(0);
      expect(category.spread).toBeLessThan(1);
    }
    for (const category of Object.values(PLACEHOLDER_COST_DATA.softCosts)) {
      expect(category.fraction).toBeGreaterThan(0);
      expect(category.fraction).toBeLessThan(1);
    }
    expect(PLACEHOLDER_COST_DATA.contingency.fraction).toBeGreaterThan(0);
  });

  it('rejects malformed tables', () => {
    expect(() => assertValidCostData({})).toThrow();
    expect(() => assertValidCostData(null)).toThrow();
    expect(() =>
      assertValidCostData({ ...PLACEHOLDER_COST_DATA, version: '' }),
    ).toThrow();
    expect(() =>
      assertValidCostData({
        ...PLACEHOLDER_COST_DATA,
        hardCosts: {
          broken: { label: 'x', scalesWith: 'buildSqft', formula: 'x', rates: { standard: -1, premium: 1, luxury: 1 }, spread: 0.1 },
        },
      }),
    ).toThrow();
  });
});
