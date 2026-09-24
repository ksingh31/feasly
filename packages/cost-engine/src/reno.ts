/**
 * Renovation estimate branch (RENO-01). Pure function of (input, costData):
 *
 *   same input + same cost_data_version  →  byte-identical output, every run.
 *
 * Shares the hard rules of src/engine.ts:
 * - No I/O, no network, no filesystem, no Date.now(), no Math.random(),
 *   no process.env. (Enforced by test/engine-purity.test.ts.)
 * - No numeric literals for calibration, limits or percentages — every
 *   tunable arrives via the CostData.reno parameter.
 * - Output carries no per-sqft unit rates and no margin percentages,
 *   only integer-dollar ranges. (Enforced by test/output-hygiene.)
 * - Renovation figures round to the data file's `roundTo` granularity
 *   (1,000) and use the asymmetric reno band (lowFactor/highFactor).
 *
 * Component semantics (per docs/plan/COST_ENGINE.md):
 * - extensive: whole-home renovation, billed on the full reno area.
 * - addition: billed on min(renoSqft, additionCapSqft) — larger additions
 *   are quoted as custom projects (the service surfaces that note).
 * - basement: billed on the full reno area; `underpinning` adds the flat
 *   (unbanded) underpinning allowance as its own component row.
 * - combined: extensive + addition + basement (+ underpinning when set).
 */
import {
  EngineInputError,
  type CostData,
  type CostRow,
  type RangedAmount,
  type RenoEstimateResult,
  type RenoInput,
  type RenoComponentKey,
  type RenoSpec,
  type TierRates,
} from './types';

/** Round to the data file's granularity (monotonically non-decreasing). */
function roundTo(value: number, granularity: number): number {
  return Math.round(value / granularity) * granularity;
}

/**
 * Asymmetric reno band. Rounding is monotonically non-decreasing, so
 * low <= base <= high holds whenever lowFactor <= 1 <= highFactor
 * (enforced when the cost-data file is loaded).
 */
function renoBand(base: number, reno: RenoSpec): RangedAmount {
  const g = reno.roundTo;
  return {
    low: roundTo(base * reno.lowFactor, g),
    base: roundTo(base, g),
    high: roundTo(base * reno.highFactor, g),
  };
}

function addBands(a: RangedAmount, b: RangedAmount): RangedAmount {
  return { low: a.low + b.low, base: a.base + b.base, high: a.high + b.high };
}

function zeroBand(): RangedAmount {
  return { low: 0, base: 0, high: 0 };
}

/** Domain limits come from the cost-data file, never from code literals. */
function checkBounds(input: RenoInput, reno: RenoSpec): void {
  const bounds = reno.inputBounds;
  if (!Number.isFinite(input.renoSqft) || !Number.isInteger(input.renoSqft)) {
    throw new EngineInputError('renoSqft must be a whole number of square feet');
  }
  if (input.renoSqft < bounds.minRenoSqft || input.renoSqft > bounds.maxRenoSqft) {
    throw new EngineInputError(
      `renoSqft ${input.renoSqft} outside [${bounds.minRenoSqft}, ${bounds.maxRenoSqft}]`,
    );
  }
}

function componentRow(
  key: RenoComponentKey,
  billableSqft: number,
  tier: keyof TierRates,
  reno: RenoSpec,
): CostRow {
  const spec = reno.components[key];
  const base = billableSqft * spec.rates[tier];
  return {
    key: `reno.${key}`,
    label: spec.label,
    formula: spec.formula,
    range: renoBand(base, reno),
  };
}

function underpinningRow(reno: RenoSpec): CostRow {
  const spec = reno.underpinning;
  const g = reno.roundTo;
  return {
    key: 'reno.underpinning',
    label: spec.label,
    formula: spec.formula,
    range: {
      low: roundTo(spec.low, g),
      base: roundTo((spec.low + spec.high) / 2, g),
      high: roundTo(spec.high, g),
    },
  };
}

function titleCase(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Run the renovation estimate. Deterministic: no clock, no randomness,
 * no I/O — the result depends only on `input` and `costData`.
 */
export function createRenoEstimate(input: RenoInput, costData: CostData): RenoEstimateResult {
  const reno = costData.reno;
  checkBounds(input, reno);

  const rows: CostRow[] = [];
  const assumptions: string[] = [];
  let total = zeroBand();

  const price = (key: RenoComponentKey, billableSqft: number): void => {
    const row = componentRow(key, billableSqft, input.tier, reno);
    total = addBands(total, row.range);
    rows.push(row);
  };

  const addUnderpinning = (): void => {
    const row = underpinningRow(reno);
    total = addBands(total, row.range);
    rows.push(row);
    assumptions.push('Underpinning included as a flat allowance (existing-foundation risk).');
  };

  const billableAddition = Math.min(input.renoSqft, reno.additionCapSqft);

  switch (input.renoType) {
    case 'extensive':
      price('extensive', input.renoSqft);
      break;
    case 'addition':
      price('addition', billableAddition);
      if (input.renoSqft > reno.additionCapSqft) {
        assumptions.push(
          `Addition area billed at the ${reno.additionCapSqft} sq ft cap ` +
            `(requested ${input.renoSqft} sq ft) — larger additions are quoted as custom projects.`,
        );
      }
      break;
    case 'basement':
      price('basement', input.renoSqft);
      if (input.underpinning) addUnderpinning();
      break;
    case 'combined':
      price('extensive', input.renoSqft);
      price('addition', billableAddition);
      price('basement', input.renoSqft);
      if (input.renoSqft > reno.additionCapSqft) {
        assumptions.push(
          `Addition component billed at the ${reno.additionCapSqft} sq ft cap ` +
            `(requested ${input.renoSqft} sq ft).`,
        );
      }
      if (input.underpinning) addUnderpinning();
      break;
    default:
      throw new EngineInputError(`unknown reno type: ${String(input.renoType)}`);
  }

  const scopeLabel =
    input.renoType === 'combined' ? 'Combined renovation' : reno.components[input.renoType].label;
  assumptions.unshift(
    `Renovation scope: ${scopeLabel}, ` +
      `${input.renoSqft} sq ft, ${titleCase(input.tier)} tier.`,
  );
  if (reno.draft || !costData.calibrated) {
    assumptions.push(reno.draftNote);
  }

  return {
    costDataVersion: costData.version,
    calibrated: costData.calibrated,
    rows,
    total,
    assumptions,
  };
}
