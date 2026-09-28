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

import { pricingCoverageIssue, type PricingCoverageBounds } from './coverage';

/**
 * Pricing-coverage guard: lot size is NEVER a coverage issue (Karan,
 * 2026-09-28) — any lot prices, quoted off the house size. Only the
 * assessed value is checked, with the engine's whole-dollar rounding.
 */
describe('pricingCoverageIssue', () => {
  const bounds: PricingCoverageBounds = {
    minLotSizeSqft: 1200,
    maxLotSizeSqft: 20000,
    minAssessedLandValue: 25000,
    maxAssessedLandValue: 10000000,
  };

  it('returns null for ordinary lots', () => {
    expect(pricingCoverageIssue({ lotSqft: 5000, assessedValue: 729000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 1200, assessedValue: 25000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 20000, assessedValue: 10000000 }, bounds)).toBeNull();
  });

  it("never blocks on lot size — Karan's 21,577 sq ft lot prices (lot-size block bug, 2026-09-28)", () => {
    expect(pricingCoverageIssue({ lotSqft: 21577, assessedValue: 729000 }, bounds)).toBeNull();
  });

  it('never blocks on very large or very small lots', () => {
    // Supersedes the old 643,811 sq ft regression: no lot size may block.
    // (assessed values below are in range — only the lot varies.)
    expect(pricingCoverageIssue({ lotSqft: 643811, assessedValue: 729000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 1199, assessedValue: 729000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 0, assessedValue: 729000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: NaN, assessedValue: 729000 }, bounds)).toBeNull();
    expect(pricingCoverageIssue({ lotSqft: 1199.4, assessedValue: 729000 }, bounds)).toBeNull();
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

  it('still flags assessed value when the lot is also extreme (lot never wins)', () => {
    expect(pricingCoverageIssue({ lotSqft: 643811, assessedValue: 0 }, bounds)).toBe(
      'assessed-value',
    );
  });
});
