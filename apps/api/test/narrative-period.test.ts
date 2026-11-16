/** Community-narrative period math (#759). */
import { describe, expect, it } from 'vitest';
import { periodOf, runWindowFor } from '../src/lib/narrative-period';

const at = (iso: string) => new Date(`${iso}T09:00:00Z`);

describe('periodOf', () => {
  it('formats the UTC month', () => {
    expect(periodOf(at('2026-01-05'))).toBe('2026-01');
    expect(periodOf(at('2026-12-31'))).toBe('2026-12');
  });
});

describe('runWindowFor (last day of month, 3 retry days)', () => {
  it('runs on the last day for next month', () => {
    expect(runWindowFor(at('2026-11-30'), 'last', 3)).toEqual({ period: '2026-12', daysSinceRunDay: 0 });
    expect(runWindowFor(at('2026-12-31'), 'last', 3)).toEqual({ period: '2027-01', daysSinceRunDay: 0 });
    expect(runWindowFor(at('2028-02-29'), 'last', 3)).toEqual({ period: '2028-03', daysSinceRunDay: 0 });
  });

  it('retries for the configured days into the next month (and year)', () => {
    expect(runWindowFor(at('2027-01-01'), 'last', 3)).toEqual({ period: '2027-01', daysSinceRunDay: 1 });
    expect(runWindowFor(at('2027-01-03'), 'last', 3)).toEqual({ period: '2027-01', daysSinceRunDay: 3 });
    expect(runWindowFor(at('2027-01-04'), 'last', 3)).toBeNull();
  });

  it('is null mid-month and the day before the run day', () => {
    expect(runWindowFor(at('2026-11-15'), 'last', 3)).toBeNull();
    expect(runWindowFor(at('2026-11-29'), 'last', 3)).toBeNull();
  });

  it('supports a fixed run day', () => {
    expect(runWindowFor(at('2026-11-25'), 25, 0)).toEqual({ period: '2026-12', daysSinceRunDay: 0 });
    expect(runWindowFor(at('2026-11-26'), 25, 0)).toBeNull();
  });
});
