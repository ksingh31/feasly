/**
 * #714 pure GST math: subtotal / tax / total in integer cents, half-up
 * rounding once per invoice, exclusive (default) and inclusive pricing.
 */
import { describe, expect, it } from 'vitest';
import {
  computeInvoiceTax,
  formatTaxRatePercent,
  normaliseTaxRatePercent,
  proportionalTaxCents,
} from '../src/lib/tax-math';
import { computeCommissionCents } from '../src/lib/commission-math';

describe('computeInvoiceTax', () => {
  it('AC1: $1,250,000 at 1.5% + 5% GST', () => {
    const commission = computeCommissionCents(125_000_000, 0.015);
    expect(commission).toBe(1_875_000);
    expect(computeInvoiceTax(commission, 5, false)).toEqual({
      subtotalCents: 1_875_000,
      taxCents: 93_750,
      totalCents: 1_968_750,
    });
  });

  it('a 0% rate is a no-op (tax disabled / legacy)', () => {
    expect(computeInvoiceTax(1_875_000, 0, false)).toEqual({
      subtotalCents: 1_875_000,
      taxCents: 0,
      totalCents: 1_875_000,
    });
    expect(computeInvoiceTax(1_875_000, 0, true)).toEqual({
      subtotalCents: 1_875_000,
      taxCents: 0,
      totalCents: 1_875_000,
    });
  });

  it('rounds half-up to the cent, exactly at the .5 boundary', () => {
    // 10 × 5% = 0.5 → 1; 9 × 5% = 0.45 → 0; 30 × 5% = 1.5 → 2
    expect(computeInvoiceTax(10, 5, false).taxCents).toBe(1);
    expect(computeInvoiceTax(9, 5, false).taxCents).toBe(0);
    expect(computeInvoiceTax(30, 5, false).taxCents).toBe(2);
    // 14.975% (QC-style) on 1,000 = 149.75 → 150 (no float drift)
    expect(computeInvoiceTax(1_000, 14.975, false).taxCents).toBe(150);
    // 13% on 2,950 = 383.5 → 384 (float 0.13 * 2950 = 383.49999…)
    expect(computeInvoiceTax(2_950, 13, false).taxCents).toBe(384);
  });

  it('is exact for very large contracts (BigInt products)', () => {
    const big = 900_000_000_000; // $9B commission, cents
    expect(computeInvoiceTax(big, 5, false)).toEqual({
      subtotalCents: big,
      taxCents: 45_000_000_000,
      totalCents: 945_000_000_000,
    });
  });

  it('inclusive: total = commission, tax = round(total × r / (1 + r))', () => {
    expect(computeInvoiceTax(1_875_000, 5, true)).toEqual({
      subtotalCents: 1_785_714,
      taxCents: 89_286,
      totalCents: 1_875_000,
    });
    // 105 incl. 5% → 100 + 5 exactly
    expect(computeInvoiceTax(105, 5, true)).toEqual({
      subtotalCents: 100,
      taxCents: 5,
      totalCents: 105,
    });
  });

  it('subtotal + tax always equals total', () => {
    for (const cents of [0, 1, 7, 99, 12_345, 1_875_001]) {
      for (const rate of [0, 5, 13, 14.975, 15]) {
        for (const inclusive of [false, true]) {
          const r = computeInvoiceTax(cents, rate, inclusive);
          expect(r.subtotalCents + r.taxCents).toBe(r.totalCents);
          expect(r.taxCents).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('rejects invalid input', () => {
    expect(() => computeInvoiceTax(-1, 5, false)).toThrow(RangeError);
    expect(() => computeInvoiceTax(1.5, 5, false)).toThrow(RangeError);
    expect(() => computeInvoiceTax(100, -1, false)).toThrow(RangeError);
    expect(() => computeInvoiceTax(100, 101, false)).toThrow(RangeError);
    expect(() => computeInvoiceTax(100, Number.NaN, false)).toThrow(RangeError);
  });
});

describe('proportionalTaxCents (refunds / credit notes)', () => {
  const inv = { taxCents: 93_750, totalCents: 1_968_750 };
  it('a full refund carries the full tax', () => {
    expect(proportionalTaxCents(inv, 1_968_750)).toBe(93_750);
  });
  it('a partial refund carries tax pro rata, half-up', () => {
    expect(proportionalTaxCents(inv, 984_375)).toBe(46_875);
    expect(proportionalTaxCents(inv, 0)).toBe(0);
    expect(proportionalTaxCents({ taxCents: 0, totalCents: 0 }, 0)).toBe(0);
  });
  it('rejects amounts outside [0, total]', () => {
    expect(() => proportionalTaxCents(inv, 1_968_751)).toThrow(RangeError);
    expect(() => proportionalTaxCents(inv, -1)).toThrow(RangeError);
  });
});

describe('rate formatting', () => {
  it('trims float dust', () => {
    expect(normaliseTaxRatePercent(5.000000001)).toBe(5);
    expect(formatTaxRatePercent(5)).toBe('5%');
    expect(formatTaxRatePercent(14.975)).toBe('14.975%');
  });
});
