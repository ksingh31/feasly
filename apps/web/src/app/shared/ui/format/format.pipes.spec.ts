import { describe, expect, it } from 'vitest';
import {
  KitCountPipe,
  KitDatePipe,
  KitDateTimePipe,
  KitMoneyPipe,
  KitRelativePipe,
} from './format.pipes';

const ISO_LIKE = /\d{4}-\d{2}-\d{2}|T\d{2}:/;
/** h:mm:ss — any seconds component in output. */
const HAS_SECONDS = /\d:\d{2}:\d{2}/;

// A summer instant: Edmonton is UTC-6 in July under both the old DST rules
// and Alberta's year-round time, so the test is tzdata-version independent.
// 2026-07-12T17:30:45Z is 11:30:45 a.m. in Edmonton.
const INSTANT = '2026-07-12T17:30:45Z';

describe('kitDate', () => {
  const pipe = new KitDatePipe();

  it('formats on the Edmonton calendar', () => {
    expect(pipe.transform(INSTANT)).toBe('Jul 12, 2026');
    // 03:00Z on the 13th is still the 12th in Edmonton.
    expect(pipe.transform('2026-07-13T03:00:00Z')).toBe('Jul 12, 2026');
  });

  it('renders an em dash, never raw ISO, for bad input', () => {
    expect(pipe.transform(null)).toBe('—');
    expect(pipe.transform(undefined)).toBe('—');
    expect(pipe.transform('not-a-date')).toBe('—');
  });
});

describe('kitDateTime', () => {
  const pipe = new KitDateTimePipe();

  it('formats date · time MT without seconds', () => {
    const out = pipe.transform(INSTANT);
    expect(out).toBe('Jul 12, 2026 · 11:30 a.m. MT');
    expect(out).not.toMatch(HAS_SECONDS);
    expect(out).not.toMatch(ISO_LIKE);
  });

  it('renders afternoon times with p.m.', () => {
    expect(pipe.transform('2026-07-01T21:05:00Z')).toBe('Jul 1, 2026 · 3:05 p.m. MT');
  });

  it('renders an em dash for bad input', () => {
    expect(pipe.transform('2026-13-45T99:00:00Z')).toBe('—');
    expect(pipe.transform(null)).toBe('—');
  });
});

describe('kitRelative', () => {
  const pipe = new KitRelativePipe();
  const now = new Date('2026-11-15T12:00:00Z');
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it.each([
    [30_000, 'Just now'],
    [5 * MIN, '5 minutes ago'],
    [3 * HOUR, '3 hours ago'],
    [DAY, 'yesterday'],
    [2 * DAY, '2 days ago'],
    [14 * DAY, '2 weeks ago'],
    [90 * DAY, '3 months ago'],
    [800 * DAY, '2 years ago'],
  ])('%i ms ago → %s', (ms, expected) => {
    expect(pipe.transform(ago(ms), now)).toBe(expected);
  });

  it('handles future instants', () => {
    expect(pipe.transform(ago(-3 * DAY), now)).toBe('in 3 days');
  });

  it('never outputs seconds', () => {
    for (const ms of [1_000, 45_000, 59_999]) {
      const out = pipe.transform(ago(ms), now);
      expect(out).toBe('Just now');
      expect(out).not.toMatch(/second/);
    }
  });

  it('renders an em dash for bad input', () => {
    expect(pipe.transform(null, now)).toBe('—');
    expect(pipe.transform('garbage', now)).toBe('—');
  });
});

describe('kitMoney', () => {
  const pipe = new KitMoneyPipe();

  it('formats integer cents as whole dollars', () => {
    expect(pipe.transform(1_980_000)).toBe('$19,800');
    expect(pipe.transform(1_980_049)).toBe('$19,800');
    expect(pipe.transform(1_980_050)).toBe('$19,801');
    expect(pipe.transform(0)).toBe('$0');
    expect(pipe.transform(-25_000)).toBe('-$250');
  });

  it('accepts whole dollars when asked', () => {
    expect(pipe.transform(650_000, 'dollars')).toBe('$650,000');
  });

  it('renders an em dash for missing values', () => {
    expect(pipe.transform(null)).toBe('—');
    expect(pipe.transform(Number.NaN)).toBe('—');
  });
});

describe('kitCount', () => {
  const pipe = new KitCountPipe();

  it('adds thousands separators', () => {
    expect(pipe.transform(1843)).toBe('1,843');
    expect(pipe.transform(1_000_000)).toBe('1,000,000');
    expect(pipe.transform(7)).toBe('7');
  });

  it('renders an em dash for missing values', () => {
    expect(pipe.transform(undefined)).toBe('—');
  });
});
