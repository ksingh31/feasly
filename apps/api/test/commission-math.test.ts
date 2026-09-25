/**
 * Commission math tests (billing/02).
 *
 * Pure functions — no DB, no Stripe. Covers the 1% rule, half-up rounding
 * at the cent boundary, and the day-difference helper.
 */
import { describe, expect, it } from 'vitest';
import {
  computeCommissionCents,
  wholeDaysBetween,
} from '../src/lib/commission-math';

describe('computeCommissionCents', () => {
  it('charges 1% of the signed construction contract value', () => {
    // $500,000.00 → $5,000.00
    expect(computeCommissionCents(50_000_000, 0.01)).toBe(500_000);
  });

  it('rounds half-up to the nearest cent', () => {
    // $150.50 × 1% = $1.505 → $1.51
    expect(computeCommissionCents(15_050, 0.01)).toBe(151);
    // $100.00 × 1% = $1.00 exactly
    expect(computeCommissionCents(10_000, 0.01)).toBe(100);
  });

  it('handles a $1 contract (minimum meaningful amount)', () => {
    // $1.00 × 1% = $0.01
    expect(computeCommissionCents(100, 0.01)).toBe(1);
  });

  it('handles large contract values without float drift', () => {
    // $9,999,999.99 × 1% = $99,999.9999 → $100,000.00
    expect(computeCommissionCents(999_999_999, 0.01)).toBe(10_000_000);
  });

  it('respects a custom commission rate', () => {
    expect(computeCommissionCents(50_000_000, 0.02)).toBe(1_000_000);
  });

  it('rejects non-positive contract values', () => {
    expect(() => computeCommissionCents(0, 0.01)).toThrow(RangeError);
    expect(() => computeCommissionCents(-100, 0.01)).toThrow(RangeError);
  });

  it('rejects non-integer cent amounts', () => {
    expect(() => computeCommissionCents(100.5, 0.01)).toThrow(RangeError);
  });

  it('rejects invalid rates', () => {
    expect(() => computeCommissionCents(10_000, 0)).toThrow(RangeError);
    expect(() => computeCommissionCents(10_000, 1.5)).toThrow(RangeError);
    expect(() => computeCommissionCents(10_000, NaN)).toThrow(RangeError);
  });
});

describe('wholeDaysBetween', () => {
  it('floors partial days', () => {
    const from = new Date('2026-09-01T12:00:00.000Z');
    const to = new Date('2026-09-03T11:59:59.000Z');
    expect(wholeDaysBetween(from, to)).toBe(1);
  });

  it('counts exact day boundaries', () => {
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-15T00:00:00.000Z');
    expect(wholeDaysBetween(from, to)).toBe(14);
  });
});
