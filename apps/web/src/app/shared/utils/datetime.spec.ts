import { describe, expect, it } from 'vitest';
import { localDateStringDaysAgo } from './datetime';

describe('localDateStringDaysAgo', () => {
  const now = new Date(2026, 10, 15, 9, 30); // Nov 15, 2026 local

  it('returns today for 0', () => {
    expect(localDateStringDaysAgo(0, now)).toBe('2026-11-15');
  });

  it('steps back calendar days across month boundaries', () => {
    expect(localDateStringDaysAgo(6, now)).toBe('2026-11-09');
    expect(localDateStringDaysAgo(29, now)).toBe('2026-10-17');
    expect(localDateStringDaysAgo(89, now)).toBe('2026-08-18');
  });

  it('crosses a year boundary', () => {
    expect(localDateStringDaysAgo(1, new Date(2026, 0, 1, 0, 5))).toBe('2025-12-31');
  });
});
