/**
 * Commission math tests (billing/02).
 *
 * Pure functions — no DB, no Stripe. Covers the 1% rule, half-up rounding
 * at the cent boundary, and the day-difference helper.
 */
import { describe, expect, it } from 'vitest';
import {
  computeCommissionCents,
  effectiveRatePercent,
  formatRatePercent,
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
    expect(() => computeCommissionCents(10_000, -0.01)).toThrow(RangeError);
    expect(() => computeCommissionCents(10_000, 1.5)).toThrow(RangeError);
    expect(() => computeCommissionCents(10_000, NaN)).toThrow(RangeError);
  });

  it('accepts a 0% negotiated rate (billing/08)', () => {
    // A 0% builder rate is a legitimate negotiated outcome — the invoice
    // is $0, not an error.
    expect(computeCommissionCents(50_000_000, 0)).toBe(0);
  });
});

describe('effectiveRatePercent (billing/08)', () => {
  const DEFAULT_RATE = 0.01;

  it('prefers the per-invoice admin override', () => {
    expect(
      effectiveRatePercent(
        { commissionRateOverride: 1.5, commissionRatePercent: 2 },
        DEFAULT_RATE,
      ),
    ).toBe(1.5);
  });

  it('falls back to the builder rate snapshotted at creation', () => {
    expect(
      effectiveRatePercent(
        { commissionRateOverride: null, commissionRatePercent: 2 },
        DEFAULT_RATE,
      ),
    ).toBe(2);
  });

  it('falls back to the configured default for legacy invoices', () => {
    expect(
      effectiveRatePercent(
        { commissionRateOverride: null, commissionRatePercent: null },
        DEFAULT_RATE,
      ),
    ).toBe(1);
  });

  it('rounds to 4 decimals for display and audit payloads', () => {
    expect(
      effectiveRatePercent(
        { commissionRateOverride: 1.23456789, commissionRatePercent: null },
        DEFAULT_RATE,
      ),
    ).toBe(1.2346);
  });
});

describe('formatRatePercent', () => {
  it("renders whole percents without decimals ('1%')", () => {
    expect(formatRatePercent(1)).toBe('1%');
  });

  it("renders fractional percents ('1.5%')", () => {
    expect(formatRatePercent(1.5)).toBe('1.5%');
  });

  it('trims float dust from stored percents', () => {
    expect(formatRatePercent(0.1 + 0.2)).toBe('0.3%');
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
