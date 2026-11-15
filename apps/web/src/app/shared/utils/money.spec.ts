import { describe, expect, it } from 'vitest';
import { formatBandCad, formatCentsRangeToCad, formatCentsToCad, roundToNearest } from './money';

/**
 * Money utils: integer-math CAD formatting (admin/02 AC2 — no float math
 * in display).
 */
describe('formatCentsToCad', () => {
  it('formats whole dollars without decimals', () => {
    expect(formatCentsToCad(50000)).toBe('$500');
    expect(formatCentsToCad(0)).toBe('$0');
  });

  it('formats cents with exact two-decimal output', () => {
    // 110 cents must be exactly $1.10 — float division (110/100) can print
    // 1.1000000000000001 in edge paths; integer math avoids it.
    expect(formatCentsToCad(110)).toBe('$1.10');
    expect(formatCentsToCad(1)).toBe('$0.01');
    expect(formatCentsToCad(99)).toBe('$0.99');
  });

  it('groups thousands with en-CA separators', () => {
    expect(formatCentsToCad(123456700)).toBe('$1,234,567');
    expect(formatCentsToCad(123456767)).toBe('$1,234,567.67');
  });

  it('handles negative amounts', () => {
    expect(formatCentsToCad(-110)).toBe('-$1.10');
    expect(formatCentsToCad(-50000)).toBe('-$500');
  });

  it('truncates fractional-cent input and guards non-finite input', () => {
    expect(formatCentsToCad(110.9)).toBe('$1.10');
    expect(formatCentsToCad(Number.NaN)).toBe('$0');
    expect(formatCentsToCad(Number.POSITIVE_INFINITY)).toBe('$0');
  });
});

describe('formatCentsRangeToCad', () => {
  it('formats a low/high range', () => {
    expect(formatCentsRangeToCad([45000000, 52000000])).toBe('$450,000 – $520,000');
    expect(formatCentsRangeToCad([100, 250])).toBe('$1 – $2.50');
  });
});

describe('roundToNearest (#488)', () => {
  it('rounds whole dollars to the nearest $1,000', () => {
    expect(roundToNearest(3235979, 1000)).toBe(3236000);
    expect(roundToNearest(3314460, 1000)).toBe(3314000);
    expect(roundToNearest(3392942, 1000)).toBe(3393000);
    expect(roundToNearest(500, 1000)).toBe(1000);
    expect(roundToNearest(499, 1000)).toBe(0);
  });

  it('never yields negative zero', () => {
    expect(Object.is(roundToNearest(-400, 1000), 0)).toBe(true);
  });

  it('falls back to whole dollars on a bad granularity, and 0 on a bad value', () => {
    expect(roundToNearest(247.48, 0)).toBe(247);
    expect(roundToNearest(247.5, Number.NaN)).toBe(248);
    expect(roundToNearest(Number.NaN, 1000)).toBe(0);
  });
});

describe('formatBandCad (#488)', () => {
  it('formats the dev total band rounded to $1,000', () => {
    expect(formatBandCad(3235979, 1000)).toBe('$3,236,000');
    expect(formatBandCad(3314460, 1000)).toBe('$3,314,000');
    expect(formatBandCad(3392942, 1000)).toBe('$3,393,000');
  });

  it('renders whole dollars at granularity 1 (per-sq-ft rates)', () => {
    expect(formatBandCad(247.48, 1)).toBe('$247');
  });
});
