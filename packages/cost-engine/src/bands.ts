/**
 * Band arithmetic shared by the new-build and comparison branches.
 *
 * Output granularity comes from the cost-data file (`CostData.roundTo`,
 * #581) — never from a code literal. Tables published before `roundTo`
 * existed (v0.1–v0.3) leave it unset and keep whole-dollar rounding, so an
 * estimate under an older pinned `cost_data_version` stays byte-identical.
 */
import type { CostData, RangedAmount } from './types';

/** Whole dollars only — cents never leave the server. */
export function wholeDollars(value: number): number {
  return Math.round(value);
}

/**
 * Round a dollar figure to the table's output granularity. Unset
 * granularity = whole dollars (pre-v0.4.0 behaviour, unchanged).
 */
export function roundOutput(value: number, granularity: number | undefined): number {
  if (granularity === undefined) return wholeDollars(value);
  return Math.round(value / granularity) * granularity;
}

/** The output granularity a table publishes (undefined = whole dollars). */
export function outputGranularity(costData: CostData): number | undefined {
  return costData.roundTo;
}

/**
 * Symmetric band around a base, rounded to `granularity`. Rounding is
 * monotonically non-decreasing, so low <= base <= high holds for every
 * non-negative base and spread.
 */
export function band(base: number, spread: number, granularity: number | undefined): RangedAmount {
  const b = roundOutput(base, granularity);
  return {
    low: roundOutput(b * (1 - spread), granularity),
    base: b,
    high: roundOutput(b * (1 + spread), granularity),
  };
}

export function addBands(a: RangedAmount, b: RangedAmount): RangedAmount {
  return { low: a.low + b.low, base: a.base + b.base, high: a.high + b.high };
}

export function zeroBand(): RangedAmount {
  return { low: 0, base: 0, high: 0 };
}
