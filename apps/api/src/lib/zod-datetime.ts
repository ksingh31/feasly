import { z } from 'zod';

/**
 * ISO-8601 datetime string (with timezone offset) that is not in the
 * future — for fields recording something that already happened (a
 * payment arriving, a contract being signed).
 *
 * Deterministic by design: `nowMs` is injected by the caller (routes pass
 * `Date.now()`), so the predicate itself does no clock reads and stays
 * unit-testable. The instant equal to `nowMs` counts as valid (inclusive).
 *
 * QA 2026-10-04 (P5/P6): mark-paid and contract-report endpoints accepted
 * future dates whenever the UI's date-picker cap was bypassed.
 */
export function pastOrPresentDatetime(fieldLabel: string, nowMs: number) {
  return z
    .string()
    .datetime({ offset: true })
    .refine((value) => new Date(value).getTime() <= nowMs, {
      message: `${fieldLabel} must not be in the future.`,
    });
}
