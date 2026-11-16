/**
 * Calibration-table integrity tests. The placeholder table is explicitly
 * uncalibrated — these tests pin that fact and guard the table's shape so
 * a malformed future version fails loudly at load time, not mid-estimate.
 */
import { describe, expect, it } from 'vitest';
import {
  assertValidCostData,
  BUNDLED_COST_DATA,
  BUNDLED_COST_DATA_VERSIONS,
  COST_DATA_V0_3_0,
  COST_DATA_V0_4_0,
  PLACEHOLDER_COST_DATA,
} from '../src/cost-data';

describe('placeholder cost-data table', () => {
  it('is versioned and explicitly marked uncalibrated', () => {
    expect(PLACEHOLDER_COST_DATA.version).toBe('v0.4.1-uncalibrated');
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

  it('rejects the removed landSpread field', () => {
    // v0.2.0 removed landSpread: the assessed land value is now a fixed
    // figure. A stale table carrying landSpread must fail loudly, not be
    // silently ignored.
    expect(() =>
      assertValidCostData({ ...PLACEHOLDER_COST_DATA, landSpread: 0.05 }),
    ).toThrow(/landSpread was removed/);
  });

  it('publishes a top-level $1,000 output granularity from v0.4.0 (#581)', () => {
    expect(PLACEHOLDER_COST_DATA.roundTo).toBe(1_000);
  });

  it('rejects a non-positive or fractional roundTo', () => {
    for (const roundTo of [0, -1000, 12.5, '1000', null]) {
      expect(() => assertValidCostData({ ...PLACEHOLDER_COST_DATA, roundTo })).toThrow(/roundTo/);
    }
  });

  it('accepts a table with no roundTo (pre-v0.4.0 whole-dollar output)', () => {
    expect(COST_DATA_V0_3_0.roundTo).toBeUndefined();
    expect(() => assertValidCostData(COST_DATA_V0_3_0)).not.toThrow();
  });

  it('keeps the previous tables bundled so pinned estimates reproduce', () => {
    expect(BUNDLED_COST_DATA_VERSIONS).toEqual([
      'v0.3.0-unclibrated',
      'v0.4.0-unclibrated',
      'v0.4.1-uncalibrated',
    ]);
    expect(BUNDLED_COST_DATA['v0.3.0-unclibrated']).toBe(COST_DATA_V0_3_0);
    expect(BUNDLED_COST_DATA['v0.4.0-unclibrated']).toBe(COST_DATA_V0_4_0);
    expect(BUNDLED_COST_DATA['v0.4.1-uncalibrated']).toBe(PLACEHOLDER_COST_DATA);
  });

  it('v0.4.0 differs from v0.3.0 only by version, comment and roundTo', () => {
    const strip = (d: Record<string, unknown>) => {
      const { version: _v, _comment: _c, roundTo: _r, ...rest } = d;
      return rest;
    };
    expect(strip({ ...COST_DATA_V0_4_0 })).toEqual(strip({ ...COST_DATA_V0_3_0 }));
  });

  it('v0.4.1 differs from v0.4.0 only by version id and comment (typo fix)', () => {
    const strip = (d: Record<string, unknown>) => {
      const { version: _v, _comment: _c, ...rest } = d;
      return rest;
    };
    expect(strip({ ...PLACEHOLDER_COST_DATA })).toEqual(strip({ ...COST_DATA_V0_4_0 }));
  });

  it('spells the current version id correctly', () => {
    expect(PLACEHOLDER_COST_DATA.version).not.toMatch(/unclibrated/);
  });
});
