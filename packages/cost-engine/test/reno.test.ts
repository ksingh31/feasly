/**
 * Renovation engine branch tests (RENO-01).
 *
 * Covers the story's acceptance criteria at the engine level:
 *  1. extensive 1,000 sqft premium matches the 0.80/1.25 band, $1k-rounded
 *  2. addition bills min(renoSqft, 400) — 600 sqft bills exactly 400
 *  3. basement + underpinning adds the flat reno.underpinning range
 *  4. combined sums its component ranges; component rows present
 *  5. the new_build branch is untouched (see engine.test.ts)
 *  6. output hygiene: no per-sqft/margin/param leakage, symbolic formulas
 *
 * All expectations are computed from the bundled placeholder table's draft
 * rates — the numbers are spelled out so a calibration change fails loudly.
 */
import { describe, expect, it } from 'vitest';
import {
  createRenoEstimate,
  EngineInputError,
  PLACEHOLDER_COST_DATA,
  type RenoEstimateResult,
  type RenoInput,
} from '../src/index';

const reno = PLACEHOLDER_COST_DATA.reno;

function run(input: RenoInput): RenoEstimateResult {
  return createRenoEstimate(input, PLACEHOLDER_COST_DATA);
}

describe('reno engine — extensive', () => {
  it('prices 1,000 sqft premium at the 0.80/1.25 band, rounded to $1,000 (AC1)', () => {
    const result = run({ renoType: 'extensive', renoSqft: 1_000, tier: 'premium', underpinning: false });
    // Draft rate: premium extensive = 230 $/sqft → base 230,000.
    expect(result.total).toEqual({ low: 184_000, base: 230_000, high: 288_000 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].key).toBe('reno.extensive');
  });

  it('is deterministic across runs', () => {
    const input: RenoInput = { renoType: 'extensive', renoSqft: 1_000, tier: 'premium', underpinning: false };
    expect(run(input)).toEqual(run(input));
  });

  it('orders tiers standard < premium < luxury', () => {
    const totals = (['standard', 'premium', 'luxury'] as const).map(
      (tier) => run({ renoType: 'extensive', renoSqft: 1_000, tier, underpinning: false }).total.base,
    );
    expect(totals).toEqual([165_000, 230_000, 310_000]);
    expect(totals[0]).toBeLessThan(totals[1]);
    expect(totals[1]).toBeLessThan(totals[2]);
  });
});

describe('reno engine — addition cap', () => {
  it('bills exactly 400 sqft when 600 is requested (AC2)', () => {
    const capped = run({ renoType: 'addition', renoSqft: 600, tier: 'premium', underpinning: false });
    const exact = run({ renoType: 'addition', renoSqft: 400, tier: 'premium', underpinning: false });
    // Billing output is identical; only the cap-note assumption differs.
    expect(capped.rows).toEqual(exact.rows);
    expect(capped.total).toEqual(exact.total);
    // Draft rate: premium addition = 360 $/sqft → 400 × 360 = 144,000 base.
    expect(capped.total.base).toBe(144_000);
  });

  it('bills the full area below the cap', () => {
    const result = run({ renoType: 'addition', renoSqft: 300, tier: 'standard', underpinning: false });
    // Draft rate: standard addition = 300 $/sqft → 300 × 300 = 90,000 base.
    expect(result.total.base).toBe(90_000);
  });

  it('notes the cap in assumptions when the request exceeds it', () => {
    const result = run({ renoType: 'addition', renoSqft: 600, tier: 'premium', underpinning: false });
    expect(result.assumptions.some((a) => a.includes('400 sq ft cap'))).toBe(true);
  });
});

describe('reno engine — basement + underpinning', () => {
  it('adds the flat underpinning range componentwise (AC3)', () => {
    const plain = run({ renoType: 'basement', renoSqft: 800, tier: 'premium', underpinning: false });
    const pinned = run({ renoType: 'basement', renoSqft: 800, tier: 'premium', underpinning: true });
    const u = reno.underpinning;
    const underpinningRow = pinned.rows.find((r) => r.key === 'reno.underpinning');
    expect(underpinningRow).toBeDefined();
    expect(underpinningRow!.range).toEqual({ low: u.low, base: 58_000, high: u.high });
    expect(pinned.total.low).toBe(plain.total.low + u.low);
    expect(pinned.total.high).toBe(plain.total.high + u.high);
  });

  it('ignores underpinning for non-basement reno types', () => {
    const result = run({ renoType: 'extensive', renoSqft: 800, tier: 'premium', underpinning: true });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].key).toBe('reno.extensive');
  });
});

describe('reno engine — combined', () => {
  it('sums the component ranges with one row per component (AC4)', () => {
    const combined = run({ renoType: 'combined', renoSqft: 1_000, tier: 'premium', underpinning: false });
    const extensive = run({ renoType: 'extensive', renoSqft: 1_000, tier: 'premium', underpinning: false });
    const addition = run({ renoType: 'addition', renoSqft: 1_000, tier: 'premium', underpinning: false });
    const basement = run({ renoType: 'basement', renoSqft: 1_000, tier: 'premium', underpinning: false });
    expect(combined.rows.map((r) => r.key)).toEqual(['reno.extensive', 'reno.addition', 'reno.basement']);
    expect(combined.total.low).toBe(extensive.total.low + addition.total.low + basement.total.low);
    expect(combined.total.base).toBe(extensive.total.base + addition.total.base + basement.total.base);
    expect(combined.total.high).toBe(extensive.total.high + addition.total.high + basement.total.high);
  });

  it('caps the addition component and adds underpinning in combined', () => {
    const result = run({ renoType: 'combined', renoSqft: 600, tier: 'standard', underpinning: true });
    expect(result.rows.map((r) => r.key)).toEqual([
      'reno.extensive',
      'reno.addition',
      'reno.basement',
      'reno.underpinning',
    ]);
    const addition400 = run({ renoType: 'addition', renoSqft: 400, tier: 'standard', underpinning: false });
    const additionRow = result.rows.find((r) => r.key === 'reno.addition');
    expect(additionRow!.range).toEqual(addition400.total);
  });
});

describe('reno engine — invariants', () => {
  const cases: RenoInput[] = [
    { renoType: 'extensive', renoSqft: 1_000, tier: 'premium', underpinning: false },
    { renoType: 'addition', renoSqft: 600, tier: 'luxury', underpinning: false },
    { renoType: 'basement', renoSqft: 800, tier: 'standard', underpinning: true },
    { renoType: 'combined', renoSqft: 1_200, tier: 'premium', underpinning: true },
  ];

  it.each(cases)('low <= base <= high for %o', (input) => {
    const { total } = run(input);
    expect(total.low).toBeLessThanOrEqual(total.base);
    expect(total.base).toBeLessThanOrEqual(total.high);
  });

  it.each(cases)('rounds every figure to the nearest $1,000 for %o', (input) => {
    const { total } = run(input);
    for (const n of [total.low, total.base, total.high]) {
      expect(n % 1_000).toBe(0);
    }
  });

  it.each(cases)('pins the frozen cost-data version for %o', (input) => {
    expect(run(input).costDataVersion).toBe(PLACEHOLDER_COST_DATA.version);
  });

  it('marks draft rates in assumptions while uncalibrated', () => {
    const result = run({ renoType: 'extensive', renoSqft: 500, tier: 'standard', underpinning: false });
    expect(result.assumptions.some((a) => a.includes('PLACEHOLDER'))).toBe(true);
  });

  it('rejects renoSqft outside the configured bounds', () => {
    expect(() =>
      run({ renoType: 'extensive', renoSqft: reno.inputBounds.minRenoSqft - 1, tier: 'standard', underpinning: false }),
    ).toThrow(EngineInputError);
    expect(() =>
      run({ renoType: 'extensive', renoSqft: reno.inputBounds.maxRenoSqft + 1, tier: 'standard', underpinning: false }),
    ).toThrow(EngineInputError);
  });

  it('rejects an unknown reno type', () => {
    expect(() =>
      run({ renoType: 'gut-rehab', renoSqft: 500, tier: 'standard', underpinning: false } as unknown as RenoInput),
    ).toThrow(EngineInputError);
  });
});

describe('reno engine — output hygiene (AC6)', () => {
  const BANNED = ['per_sqft', 'persqft', 'unit_rate', 'unitrate', 'margin', 'param'];

  it('leaks no calibration terms in the serialized result', () => {
    const result = run({ renoType: 'combined', renoSqft: 600, tier: 'premium', underpinning: true });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const fragment of BANNED) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it('keeps formulas symbolic — no numeric literals', () => {
    const result = run({ renoType: 'combined', renoSqft: 600, tier: 'premium', underpinning: true });
    for (const row of result.rows) {
      expect(row.formula).not.toMatch(/\d/);
    }
  });
});
