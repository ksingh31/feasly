import { describe, expect, it } from 'vitest';
import { detectCoverageSignal } from './coverage';

/**
 * Coverage-heuristic tests (frontend port of apps/api/src/lib/coverage.ts).
 *
 * The heuristic is deliberately conservative: ambiguous input must return
 * 'ambiguous' so callers fall back to the generic not-found copy rather than
 * wrongly telling a Calgarian they're out of coverage.
 */
describe('detectCoverageSignal', () => {
  describe('calgary signals', () => {
    it.each([
      'T2X 1A1',
      't2x1a1',
      'T3B 2K7',
      '123 Main St, Calgary, AB T2P 3C8',
      '1600 90 AV SW Calgary',
    ])('"%s" → calgary', (input) => {
      expect(detectCoverageSignal(input)).toBe('calgary');
    });
  });

  describe('out-of-coverage signals', () => {
    it.each([
      'V6B 1A1',
      'v6b1a1',
      'M5V 3A8',
      'K1A 0B1',
      'T5J 0X1', // Edmonton FSA — not Calgary
      '100 Queen St W, Toronto',
      '456 Robson St, Vancouver',
      '789 Whyte Ave, Edmonton',
      'Edmonton',
    ])('"%s" → out-of-coverage', (input) => {
      expect(detectCoverageSignal(input)).toBe('out-of-coverage');
    });
  });

  describe('ambiguous (conservative fallback)', () => {
    it.each([
      '',
      '   ',
      '16 ave',
      '918 16 AVE NW',
      '2631 63 AV SW',
      'Main Street',
      'T2', // partial postal code — not enough signal
    ])('"%s" → ambiguous', (input) => {
      expect(detectCoverageSignal(input)).toBe('ambiguous');
    });
  });

  describe('precedence', () => {
    it('an explicit Calgary signal wins over a conflicting city token', () => {
      expect(detectCoverageSignal('123 Edmonton Tr, Calgary')).toBe('calgary');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { pricingCoverageIssue, type PricingCoverageBounds } from './coverage';

/**
 * Early lot-coverage guard: must fire on exactly the same condition as the
 * engine's late check (checkBounds in packages/cost-engine/src/engine.ts) —
 * lot size first, then assessed value, whole-dollar rounding.
 */
describe('pricingCoverageIssue', () => {
  const bounds: PricingCoverageBounds = {
    minLotSizeSqft: 1200,
    maxLotSizeSqft: 20000,
    minAssessedLandValue: 25000,
    maxAssessedLandValue: 10000000,
  };

  it('returns null for a lot inside the range (Karan regression: 643,811 sq ft must NOT pass)', () => {
    expect(pricingCoverageIssue({ lotSqft: 5000, assessedValue: 729000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 1200, assessedValue: 25000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 20000, assessedValue: 10000000 }, bounds)).toBeNull();
  });

  it("flags Karan's 643,811 sq ft lot as 'lot-size'", () => {
    expect(pricingCoverageIssue({ lotSqft: 643811, assessedValue: 61586000 }, bounds)).toBe(
      'lot-size',
    );
  });

  it("flags lots below the minimum as 'lot-size'", () => {
    expect(pricingCoverageIssue({ lotSqft: 1199, assessedValue: 729000 }, bounds)).toBe('lot-size');
    expect(pricingCoverageIssue({ lotSqft: 0, assessedValue: 729000 }, bounds)).toBe('lot-size');
  });

  it('treats non-finite lot sizes as out of coverage', () => {
    expect(pricingCoverageIssue({ lotSqft: NaN, assessedValue: 729000 }, bounds)).toBe('lot-size');
  });

  it('rounds fractional lot sizes like the engine (whole dollars)', () => {
    // 1199.6 rounds to 1200 → in range, same as the engine's wholeDollars.
    expect(pricingCoverageIssue({ lotSqft: 1199.6, assessedValue: 729000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 1199.4, assessedValue: 729000 }, bounds)).toBe('lot-size');
  });

  it("flags missing/out-of-range assessed values as 'assessed-value'", () => {
    expect(pricingCoverageIssue({ lotSqft: 5000, assessedValue: 0 }, bounds)).toBe('assessed-value');
    expect(pricingCoverageIssue({ lotSqft: 5000, assessedValue: 24999 }, bounds)).toBe(
      'assessed-value',
    );
    expect(pricingCoverageIssue({ lotSqft: 5000, assessedValue: 10000001 }, bounds)).toBe(
      'assessed-value',
    );
  });

  it('checks lot size before assessed value (engine order)', () => {
    // Both out of range → the lot-size copy wins, matching the engine.
    expect(pricingCoverageIssue({ lotSqft: 643811, assessedValue: 0 }, bounds)).toBe('lot-size');
  });
});
