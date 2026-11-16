/** Pure dunning schedule math (#718). */
import { describe, expect, it } from 'vitest';
import {
  daysOverdue,
  effectiveGraceDays,
  isDunningState,
  manualDueAt,
  retriesExhausted,
  retryDueAt,
} from '../src/lib/dunning-schedule';

const AT = new Date('2026-11-10T12:00:00.000Z');

describe('dunning schedule', () => {
  it('uses the invoice override, then the configured default, then 7 days', () => {
    expect(effectiveGraceDays(3, 10)).toBe(3);
    expect(effectiveGraceDays(null, 10)).toBe(10);
    expect(effectiveGraceDays(null, undefined)).toBe(7);
  });

  it('schedules the retry and the manual due date one grace period out', () => {
    expect(retryDueAt(AT, 3).toISOString()).toBe('2026-11-13T12:00:00.000Z');
    expect(manualDueAt(AT, 7).toISOString()).toBe('2026-11-17T12:00:00.000Z');
  });

  it('counts whole days overdue and never negative', () => {
    expect(daysOverdue(AT, new Date('2026-11-09T12:00:00.000Z'))).toBe(0);
    expect(daysOverdue(AT, AT)).toBe(0);
    expect(daysOverdue(AT, new Date('2026-11-11T11:59:59.000Z'))).toBe(0);
    expect(daysOverdue(AT, new Date('2026-11-12T12:00:00.000Z'))).toBe(2);
  });

  it('knows when retries are used up and which states are valid', () => {
    expect(retriesExhausted(2, 3)).toBe(false);
    expect(retriesExhausted(3, 3)).toBe(true);
    expect(isDunningState('paused')).toBe(true);
    expect(isDunningState('stopped')).toBe(false);
  });
});
