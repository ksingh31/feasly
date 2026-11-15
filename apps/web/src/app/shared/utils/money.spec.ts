import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import {
  centsToGroupedDollars,
  formatCentsRangeToCad,
  formatCentsToCad,
  formatCompactCad,
  formatCompactRange,
  formatPerSqftCad,
  formatRoundedCad,
  groupDollarDigits,
} from './money';

/** The configured estimate display step (#608) — 1000 in the defaults. */
const STEP = DEFAULT_APP_CONFIG.limits.estimateRoundingStep;

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

/** #504 / review M1: consumer estimate figures never render unrounded. */
describe('estimate display rounding', () => {
  it('rounds to the nearest $1,000', () => {
    expect(formatRoundedCad(609_901, STEP)).toBe('$610,000');
    expect(formatRoundedCad(580_499, STEP)).toBe('$580,000');
    expect(formatRoundedCad(Number.NaN, STEP)).toBe('$0');
  });

  it('rounds to whatever step the caller passes (#608: step comes from ConfigService)', () => {
    expect(formatRoundedCad(609_901, 5_000)).toBe('$610,000');
    expect(formatRoundedCad(612_600, 5_000)).toBe('$615,000');
    expect(formatRoundedCad(609_901, 100)).toBe('$609,900');
    expect(formatCompactCad(612_600, 5_000)).toBe('$615,000');
  });

  it('falls back to whole dollars for a non-positive or non-finite step', () => {
    expect(formatRoundedCad(609_901.4, 0)).toBe('$609,901');
    expect(formatRoundedCad(609_901, -1_000)).toBe('$609,901');
    expect(formatRoundedCad(609_901, Number.NaN)).toBe('$609,901');
  });

  it('renders millions compact with $10k precision', () => {
    expect(formatCompactCad(3_243_817, STEP)).toBe('$3.24M');
    expect(formatCompactCad(3_305_000, STEP)).toBe('$3.31M');
    expect(formatCompactCad(1_000_000, STEP)).toBe('$1.00M');
    expect(formatCompactCad(12_049_999, STEP)).toBe('$12.05M');
  });

  it('renders sub-million figures rounded to $1,000', () => {
    expect(formatCompactCad(608_456, STEP)).toBe('$608,000');
    // Rounds up across the boundary into compact form.
    expect(formatCompactCad(999_999, STEP)).toBe('$1.00M');
  });

  it('formats a headline range', () => {
    expect(formatCompactRange({ low: 3_241_000, high: 3_386_200 }, STEP)).toBe('$3.24M – $3.39M');
    expect(formatCompactRange({ low: 608_456, high: 734_900 }, STEP)).toBe('$608,000 – $735,000');
  });

  it('formats per-sq-ft in whole dollars', () => {
    expect(formatPerSqftCad(242.37)).toBe('$242');
    expect(formatPerSqftCad(-1)).toBe('$0');
    expect(formatPerSqftCad(Number.POSITIVE_INFINITY)).toBe('$0');
  });
});

describe('groupDollarDigits (#496 MoneyField)', () => {
  it('inserts en-CA thousands separators', () => {
    expect(groupDollarDigits('1250000')).toBe('1,250,000');
    expect(groupDollarDigits('999')).toBe('999');
    expect(groupDollarDigits('1000')).toBe('1,000');
  });

  it('ignores non-digits and drops leading zeros', () => {
    expect(groupDollarDigits('1,25a0,000')).toBe('1,250,000');
    expect(groupDollarDigits('007')).toBe('7');
    expect(groupDollarDigits('0')).toBe('0');
    expect(groupDollarDigits('')).toBe('');
  });
});

describe('centsToGroupedDollars (#496 MoneyField)', () => {
  it('renders integer cents as grouped whole dollars', () => {
    expect(centsToGroupedDollars(125000000)).toBe('1,250,000');
    expect(centsToGroupedDollars(0)).toBe('0');
  });

  it('truncates cents and blanks invalid input', () => {
    expect(centsToGroupedDollars(125099)).toBe('1,250');
    expect(centsToGroupedDollars(null)).toBe('');
    expect(centsToGroupedDollars(-100)).toBe('');
    expect(centsToGroupedDollars(Number.NaN)).toBe('');
  });
});
