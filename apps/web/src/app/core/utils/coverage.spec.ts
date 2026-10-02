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

import {
  pricingCoverageIssue,
  type PricingCoverageBounds,
  type PricingCoverageFacts,
} from './coverage';

/**
 * Pricing-coverage guard: lot size is NEVER a coverage issue (Karan,
 * 2026-09-28) — any lot prices, quoted off the house size. Checked, in
 * precedence order: non-residential, unsupported property type (final rule,
 * Karan 2026-10-02: every zone where a single-detached dwelling is a listed
 * use per Land Use Bylaw 1P2007 — R-C1/R-C1S/R-C2/R-CG/R-G/H-GO), assessed
 * value. Blank/unknown zoning and DC never block (fail open).
 */
describe('pricingCoverageIssue', () => {
  const bounds: PricingCoverageBounds = {
    minLotSizeSqft: 1200,
    maxLotSizeSqft: 20000,
    minAssessedLandValue: 25000,
    maxAssessedLandValue: 10000000,
  };

  const facts = (overrides: Partial<PricingCoverageFacts> = {}): PricingCoverageFacts => ({
    lotSqft: 5000,
    assessedValue: 729000,
    isNonResidential: false,
    zoning: 'R-C1',
    ...overrides,
  });

  it('returns null for ordinary single-family lots', () => {
    expect(pricingCoverageIssue(facts(), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ lotSqft: 1200, assessedValue: 25000 }), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ lotSqft: 20000, assessedValue: 10000000 }), bounds)).toBeNull();
  });

  it('keeps single-family-buildable zones eligible (case-insensitive, whitespace-tolerant)', () => {
    // Final rule (Karan, 2026-10-02): every zone where a single-detached
    // dwelling is a listed use per the City's Land Use Bylaw 1P2007.
    // R-C2 (duplex) is eligible — single-family homes do get built in
    // duplex-zoned areas; R-CG/R-G cover most inner-city infill teardowns.
    for (const zoning of ['R-C1', 'R-C1S', 'R-C2', 'R-CG', 'R-G', 'H-GO', 'r-cg', 'h-go', '  R-G  ']) {
      expect(pricingCoverageIssue(facts({ zoning }), bounds)).toBeNull();
    }
  });

  it("never blocks on lot size — Karan's 21,577 sq ft lot prices (lot-size block bug, 2026-09-28)", () => {
    expect(pricingCoverageIssue(facts({ lotSqft: 21577 }), bounds)).toBeNull();
  });

  it('never blocks on very large or very small lots', () => {
    // Supersedes the old 643,811 sq ft regression: no lot size may block.
    // (assessed values below are in range — only the lot varies.)
    expect(pricingCoverageIssue(facts({ lotSqft: 643811 }), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ lotSqft: 1199 }), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ lotSqft: 0 }), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ lotSqft: NaN }), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ lotSqft: 1199.4 }), bounds)).toBeNull();
  });

  it("flags missing/out-of-range assessed values as 'assessed-value'", () => {
    expect(pricingCoverageIssue(facts({ assessedValue: 0 }), bounds)).toBe('assessed-value');
    expect(pricingCoverageIssue(facts({ assessedValue: 24999 }), bounds)).toBe('assessed-value');
    expect(pricingCoverageIssue(facts({ assessedValue: 10000001 }), bounds)).toBe('assessed-value');
  });

  it('still flags assessed value when the lot is also extreme (lot never wins)', () => {
    expect(pricingCoverageIssue(facts({ lotSqft: 643811, assessedValue: 0 }), bounds)).toBe('assessed-value');
  });

  it("flags non-residential parcels as 'non-residential' (industrial/commercial)", () => {
    expect(pricingCoverageIssue(facts({ lotSqft: 452960, isNonResidential: true }), bounds)).toBe(
      'non-residential',
    );
  });

  it("non-residential takes precedence over the assessed-value issue (Karan's 12345 40 St SE industrial case)", () => {
    // The industrial parcel's $61.58M assessed value ALSO breaks the $10M
    // cap — the user must see the specific commercial/industrial message,
    // not the generic can't-price card.
    expect(
      pricingCoverageIssue(facts({ lotSqft: 452960, assessedValue: 61580000, isNonResidential: true }), bounds),
    ).toBe('non-residential');
    expect(pricingCoverageIssue(facts({ assessedValue: 0, isNonResidential: true }), bounds)).toBe(
      'non-residential',
    );
  });

  it("flags M-*, C-*, I-* and other non-single-family zoning as 'unsupported-property-type'", () => {
    for (const zoning of ['M-C1', 'M-C2', 'M-H1', 'M-X1', 'C-COR1', 'C-COR2', 'I-G', 'I-C', 'S-CRI', 'S-R']) {
      expect(pricingCoverageIssue(facts({ zoning }), bounds)).toBe('unsupported-property-type');
    }
  });

  it('fails open on blank zoning and DC — never blocks on missing data', () => {
    expect(pricingCoverageIssue(facts({ zoning: '' }), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ zoning: '   ' }), bounds)).toBeNull();
    // Direct Control is common for new-community greenfield lots: eligible.
    expect(pricingCoverageIssue(facts({ zoning: 'DC' }), bounds)).toBeNull();
    expect(pricingCoverageIssue(facts({ zoning: 'dc' }), bounds)).toBeNull();
  });

  it("precedence: non-residential > unsupported-property-type > assessed-value (Karan, 2026-10-02)", () => {
    // An M-C2 parcel whose assessed value also breaks the cap: the user
    // sees the single-family message, not the generic can't-price card.
    expect(pricingCoverageIssue(facts({ zoning: 'M-C2', assessedValue: 61580000 }), bounds)).toBe(
      'unsupported-property-type',
    );
    // Commercial/industrial wins even on an unsupported designation.
    expect(
      pricingCoverageIssue(facts({ zoning: 'M-X2', assessedValue: 0, isNonResidential: true }), bounds),
    ).toBe('non-residential');
  });
});
