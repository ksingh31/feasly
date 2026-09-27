/**
 * Business-day helper tests (dispute console, billing/01 follow-on).
 *
 * Pure functions — no DB, no clock. America/Edmonton is UTC-7 year-round
 * (Alberta does not observe DST), so the fixed instants below are exact.
 */
import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  businessDaysBetween,
  DISPUTE_SLA_BUSINESS_DAYS,
  DISPUTE_SLA_TIMEZONE,
  isBusinessDay,
} from '../src/lib/business-days';

const TZ = DISPUTE_SLA_TIMEZONE;

// 2026-09-28 is a Monday; times are 10:00 America/Edmonton (17:00 UTC).
const MON_10AM = new Date('2026-09-28T17:00:00.000Z');
const FRI_10AM = new Date('2026-10-02T17:00:00.000Z');
const SAT_NOON = new Date('2026-10-03T18:00:00.000Z');
const SUN_NOON = new Date('2026-10-04T18:00:00.000Z');
const NEXT_MON_10AM = new Date('2026-10-05T17:00:00.000Z');

describe('business-days', () => {
  it('exposes the dispute SLA constants', () => {
    expect(DISPUTE_SLA_TIMEZONE).toBe('America/Edmonton');
    expect(DISPUTE_SLA_BUSINESS_DAYS).toBe(5);
  });

  it('isBusinessDay is false on weekends, true on weekdays', () => {
    expect(isBusinessDay(MON_10AM, TZ)).toBe(true);
    expect(isBusinessDay(FRI_10AM, TZ)).toBe(true);
    expect(isBusinessDay(SAT_NOON, TZ)).toBe(false);
    expect(isBusinessDay(SUN_NOON, TZ)).toBe(false);
  });

  it('addBusinessDays: Monday + 5 = next Monday, wall time preserved', () => {
    expect(addBusinessDays(MON_10AM, 5, TZ).toISOString()).toBe(
      NEXT_MON_10AM.toISOString(),
    );
  });

  it('addBusinessDays skips weekends', () => {
    // Friday + 1 → Monday; Friday + 5 → the following Friday.
    expect(addBusinessDays(FRI_10AM, 1, TZ).toISOString()).toBe(
      NEXT_MON_10AM.toISOString(),
    );
    expect(addBusinessDays(FRI_10AM, 5, TZ).toISOString()).toBe(
      '2026-10-09T17:00:00.000Z',
    );
  });

  it('addBusinessDays with 0 returns the same instant', () => {
    expect(addBusinessDays(MON_10AM, 0, TZ).toISOString()).toBe(
      MON_10AM.toISOString(),
    );
  });

  it('addBusinessDays rejects negative or fractional counts', () => {
    expect(() => addBusinessDays(MON_10AM, -1, TZ)).toThrow(RangeError);
    expect(() => addBusinessDays(MON_10AM, 1.5, TZ)).toThrow(RangeError);
  });

  it('businessDaysBetween counts weekdays in (from, to]', () => {
    // Mon Sep 28 → Fri Oct 2: Tue, Wed, Thu, Fri = 4.
    expect(businessDaysBetween(MON_10AM, FRI_10AM, TZ)).toBe(4);
    // Fri Oct 2 → Mon Oct 5: Sat/Sun skipped, Monday counts = 1.
    expect(businessDaysBetween(FRI_10AM, NEXT_MON_10AM, TZ)).toBe(1);
  });

  it('businessDaysBetween is 0 on the same calendar date', () => {
    expect(businessDaysBetween(MON_10AM, MON_10AM, TZ)).toBe(0);
    expect(
      businessDaysBetween(
        MON_10AM,
        new Date('2026-09-28T23:00:00.000Z'),
        TZ,
      ),
    ).toBe(0);
  });

  it('businessDaysBetween negates when reversed', () => {
    expect(businessDaysBetween(NEXT_MON_10AM, FRI_10AM, TZ)).toBe(-1);
    expect(businessDaysBetween(FRI_10AM, MON_10AM, TZ)).toBe(-4);
  });
});
