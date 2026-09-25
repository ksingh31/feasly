/**
 * Pure billing-deadline helpers (billing/01 foundation).
 *
 * No I/O, no clock — every timestamp is injected, so these tests are
 * fully deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
  attributionDeadline,
  isReportingOnTime,
  isWithinAttributionWindow,
  reportingDeadline,
  wholeDaysUntil,
} from '../src/lib/billing-deadlines';

const INTRODUCED = new Date('2026-01-15T10:00:00.000Z');
const WINDOW_DAYS = 365; // 12-month attribution window (Karan 2026-09-24)
const SLA_DAYS = 14; // 14-day reporting SLA (Karan 2026-09-24)

describe('attributionDeadline', () => {
  it('adds the window in whole days to the introduction instant', () => {
    const deadline = attributionDeadline(INTRODUCED, WINDOW_DAYS);
    expect(deadline.toISOString()).toBe('2027-01-15T10:00:00.000Z');
  });

  it('rejects a non-positive window', () => {
    expect(() => attributionDeadline(INTRODUCED, 0)).toThrow(RangeError);
    expect(() => attributionDeadline(INTRODUCED, -30)).toThrow(RangeError);
    expect(() => attributionDeadline(INTRODUCED, 1.5)).toThrow(RangeError);
  });
});

describe('isWithinAttributionWindow', () => {
  it('accepts a signature well inside the window', () => {
    expect(
      isWithinAttributionWindow(INTRODUCED, new Date('2026-06-01T00:00:00.000Z'), WINDOW_DAYS),
    ).toBe(true);
  });

  it('accepts a signature exactly on the deadline instant (inclusive)', () => {
    const deadline = attributionDeadline(INTRODUCED, WINDOW_DAYS);
    expect(isWithinAttributionWindow(INTRODUCED, deadline, WINDOW_DAYS)).toBe(true);
  });

  it('rejects a signature one millisecond past the deadline', () => {
    const past = new Date(attributionDeadline(INTRODUCED, WINDOW_DAYS).getTime() + 1);
    expect(isWithinAttributionWindow(INTRODUCED, past, WINDOW_DAYS)).toBe(false);
  });

  it('rejects a signature before the introduction', () => {
    expect(
      isWithinAttributionWindow(
        INTRODUCED,
        new Date('2025-12-31T23:59:59.000Z'),
        WINDOW_DAYS,
      ),
    ).toBe(true); // before the deadline instant counts as inside
  });
});

describe('reportingDeadline', () => {
  it('adds the SLA in whole days to the signature instant', () => {
    const signed = new Date('2026-03-01T09:30:00.000Z');
    expect(reportingDeadline(signed, SLA_DAYS).toISOString()).toBe(
      '2026-03-15T09:30:00.000Z',
    );
  });

  it('rejects a non-positive SLA', () => {
    expect(() => reportingDeadline(INTRODUCED, 0)).toThrow(RangeError);
  });
});

describe('isReportingOnTime', () => {
  const signed = new Date('2026-03-01T09:30:00.000Z');

  it('accepts a report on the deadline instant', () => {
    expect(
      isReportingOnTime(signed, reportingDeadline(signed, SLA_DAYS), SLA_DAYS),
    ).toBe(true);
  });

  it('rejects a report after the deadline', () => {
    const late = new Date(reportingDeadline(signed, SLA_DAYS).getTime() + 60_000);
    expect(isReportingOnTime(signed, late, SLA_DAYS)).toBe(false);
  });
});

describe('wholeDaysUntil', () => {
  it('floors partial days', () => {
    const deadline = new Date('2026-04-01T12:00:00.000Z');
    expect(wholeDaysUntil(deadline, new Date('2026-03-30T12:00:01.000Z'))).toBe(1);
  });

  it('goes negative when overdue', () => {
    const deadline = new Date('2026-04-01T12:00:00.000Z');
    expect(wholeDaysUntil(deadline, new Date('2026-04-03T12:00:00.000Z'))).toBe(-2);
  });

  it('returns 0 on the deadline day before the instant', () => {
    const deadline = new Date('2026-04-01T12:00:00.000Z');
    expect(wholeDaysUntil(deadline, new Date('2026-04-01T11:00:00.000Z'))).toBe(0);
  });
});
