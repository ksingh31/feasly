/**
 * consumer/02 — lead-score heuristic unit tests.
 *
 * Pure function, no db: fast table-driven coverage of the documented
 * scoring bands plus the never-throw guarantee for unknown timelines.
 */
import { describe, expect, it } from 'vitest';
import { computeLeadScore } from '../src/lib/lead-score';

describe('computeLeadScore', () => {
  it('scores timeline urgency as the dominant signal', () => {
    const base = { marketingConsent: false, hasPhone: false };
    expect(computeLeadScore({ ...base, timeline: '0-3mo' })).toBe(40);
    expect(computeLeadScore({ ...base, timeline: '3-6mo' })).toBe(30);
    expect(computeLeadScore({ ...base, timeline: '6-12mo' })).toBe(20);
    expect(computeLeadScore({ ...base, timeline: '12+mo' })).toBe(10);
    expect(computeLeadScore({ ...base, timeline: 'exploring' })).toBe(5);
  });

  it('treats unknown timeline strings like exploring, never throws', () => {
    expect(
      computeLeadScore({
        timeline: 'someday-maybe',
        marketingConsent: false,
        hasPhone: false,
      }),
    ).toBe(5);
  });

  it('adds consent, phone, and high-value bands additively', () => {
    expect(
      computeLeadScore({
        timeline: '3-6mo',
        marketingConsent: true,
        hasPhone: true,
        estimateTotalBase: 1_200_000,
      }),
    ).toBe(30 + 10 + 10 + 10);
  });

  it('caps at the documented maximum of 70', () => {
    expect(
      computeLeadScore({
        timeline: '0-3mo',
        marketingConsent: true,
        hasPhone: true,
        estimateTotalBase: 5_000_000,
      }),
    ).toBe(70);
  });

  it('does not award the value band below the $1M threshold', () => {
    const input = {
      timeline: '0-3mo',
      marketingConsent: false,
      hasPhone: false,
      estimateTotalBase: 999_999,
    } as const;
    expect(computeLeadScore(input)).toBe(40);
  });

  it('ignores non-finite or missing estimate totals', () => {
    const base = { timeline: '0-3mo', marketingConsent: false, hasPhone: false };
    expect(computeLeadScore({ ...base, estimateTotalBase: NaN })).toBe(40);
    expect(computeLeadScore({ ...base })).toBe(40);
  });
});
