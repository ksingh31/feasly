/**
 * Output-hygiene tests — the product rules, enforced in code:
 * - no per-sqft unit rates anywhere in the output,
 * - no margin percentages anywhere in the output,
 * - formulas stay symbolic (named coefficients, no numeric literals),
 * - every dollar figure is a whole integer.
 */
import { describe, expect, it } from 'vitest';
import { createEstimate } from '../src/engine';
import { PLACEHOLDER_COST_DATA } from '../src/cost-data';

/** Banned key fragments: anything smelling like a unit rate or a margin. */
const BANNED_KEY_FRAGMENTS = [
  'persqft',
  'per_sqft',
  'unitrate',
  'unit_rate',
  'percent',
  'margin',
];

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function collectNumbers(value: unknown, numbers: number[] = []): number[] {
  if (typeof value === 'number') {
    numbers.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, numbers);
  } else if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) collectNumbers(child, numbers);
  }
  return numbers;
}

describe('estimate output hygiene', () => {
  const result = createEstimate(
    {
      property: { assessedLandValue: 450_000, lotSizeSqft: 5_000, zoning: 'R-C1' },
      scope: { buildSqft: 2_200, tier: 'premium' },
    },
    PLACEHOLDER_COST_DATA,
  );

  it('contains no per-sqft or margin keys', () => {
    const keys = collectKeys(result).map((k) => k.toLowerCase());
    for (const fragment of BANNED_KEY_FRAGMENTS) {
      expect(keys.filter((k) => k.includes(fragment))).toEqual([]);
    }
  });

  it('keeps formulas symbolic — no numeric literals', () => {
    for (const row of result.rows) {
      expect(row.formula).not.toMatch(/\d/);
    }
  });

  it('emits whole dollars only', () => {
    for (const n of collectNumbers(result)) {
      expect(Number.isInteger(n)).toBe(true);
    }
  });
});
