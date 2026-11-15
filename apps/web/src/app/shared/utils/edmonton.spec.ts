/**
 * Edmonton billing-calendar util tests.
 *
 * edmontonDayDiff is day-granular on the America/Edmonton calendar:
 * instants are compared by calendar day, not by 24-hour periods, so a
 * deadline later today is 0 even if it is only hours away.
 */
import { describe, expect, it } from 'vitest';
import {
  edmontonDayDiff,
  formatEdmontonDatePlusDays,
  formatEdmontonMediumDate,
} from './edmonton';

const DAY_MS = 86_400_000;

describe('edmontonDayDiff', () => {
  it('returns 0 for an instant today', () => {
    expect(edmontonDayDiff(new Date().toISOString())).toBe(0);
  });

  it('returns positive days for future instants', () => {
    const iso = new Date(Date.now() + 3 * DAY_MS).toISOString();
    expect(edmontonDayDiff(iso)).toBe(3);
  });

  it('returns negative days for past instants', () => {
    const iso = new Date(Date.now() - 2 * DAY_MS).toISOString();
    expect(edmontonDayDiff(iso)).toBe(-2);
  });

  it('returns null for unparseable input', () => {
    expect(edmontonDayDiff('not-a-date')).toBeNull();
  });
});

describe('formatEdmontonMediumDate', () => {
  it('formats an ISO instant as an Edmonton medium date', () => {
    // Noon UTC on Oct 1 is still Oct 1 in Edmonton (UTC-6).
    expect(formatEdmontonMediumDate('2026-10-01T12:00:00Z')).toBe(
      'Oct 1, 2026',
    );
  });

  it('returns an em dash for null or invalid input', () => {
    expect(formatEdmontonMediumDate(null)).toBe('—');
    expect(formatEdmontonMediumDate('garbage')).toBe('—');
  });
});

describe('formatEdmontonDatePlusDays (#529)', () => {
  it('adds whole days to today on the Edmonton calendar', () => {
    expect(formatEdmontonDatePlusDays(7, new Date('2026-11-15T18:00:00Z'))).toBe('Nov 22, 2026');
  });

  it('uses the Edmonton day, not the UTC day, near midnight', () => {
    // 03:00 UTC on Nov 16 is still Nov 15 in Edmonton (UTC−7).
    expect(formatEdmontonDatePlusDays(7, new Date('2026-11-16T03:00:00Z'))).toBe('Nov 22, 2026');
  });

  it('crosses month and DST boundaries by calendar day', () => {
    expect(formatEdmontonDatePlusDays(7, new Date('2026-10-30T18:00:00Z'))).toBe('Nov 6, 2026');
  });
});
