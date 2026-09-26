import { describe, expect, it } from 'vitest';
import { formatCentsRangeToCad, formatCentsToCad } from './money';

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
