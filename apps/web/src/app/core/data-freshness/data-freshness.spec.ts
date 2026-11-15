import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '../config/app-config.defaults';
import { formatFreshnessLine, shortMonthYear } from './data-freshness';

/** #513: one freshness string, built from config templates only. */
describe('formatFreshnessLine', () => {
  const copy = DEFAULT_APP_CONFIG.copy.dataFreshness;

  it('builds the review S9 line from roll year + check month', () => {
    const res = formatFreshnessLine(copy, 2026, 'November 2026');
    expect(res.lead).toBe('2026 assessment roll');
    expect(res.detail).toBe('(City of Calgary) · checked Nov 2026');
    expect(res.line).toBe('2026 assessment roll (City of Calgary) · checked Nov 2026');
  });

  it('line is always lead + space + detail', () => {
    const res = formatFreshnessLine(copy, '2025', 'January 2026');
    expect(res.line).toBe(`${res.lead} ${res.detail}`);
  });

  it('never claims a year or month it does not have', () => {
    expect(formatFreshnessLine(copy, null, 'November 2026').line).toBe(
      'Current assessment roll (City of Calgary) · checked Nov 2026',
    );
    expect(formatFreshnessLine(copy, 2026, null).line).toBe('2026 assessment roll (City of Calgary)');
    expect(formatFreshnessLine(copy, undefined, undefined).line).toBe(
      'Current assessment roll (City of Calgary)',
    );
  });
});

describe('shortMonthYear', () => {
  it('abbreviates the month', () => {
    expect(shortMonthYear('September 2026')).toBe('Sep 2026');
    expect(shortMonthYear(' May  2026 ')).toBe('May 2026');
  });
});
