/**
 * The deterministic estimate engine. Pure function of (input, costData):
 *
 *   same input + same cost_data_version  →  byte-identical output, every run.
 *
 * Hard rules:
 * - No I/O, no network, no filesystem, no Date.now(), no Math.random(),
 *   no process.env. (Enforced by test/engine-purity.test.ts.)
 * - No numeric literals for calibration, limits or percentages — every
 *   tunable arrives via the CostData parameter.
 * - Output carries no per-sqft unit rates and no margin percentages,
 *   only integer-dollar ranges. (Enforced by test/output-hygiene.)
 */
import {
  EngineInputError,
  type CostData,
  type CostRow,
  type EngineInput,
  type EstimateResult,
  type FixedAmount,
  type RangedAmount,
} from './types';

/** Whole dollars only — cents never leave the server. */
function wholeDollars(value: number): number {
  return Math.round(value);
}

/**
 * Symmetric band around a base. Math.round is monotonically non-decreasing,
 * so low <= base <= high holds for every non-negative base and spread.
 */
function band(base: number, spread: number): RangedAmount {
  const b = wholeDollars(base);
  return {
    low: wholeDollars(b * (1 - spread)),
    base: b,
    high: wholeDollars(b * (1 + spread)),
  };
}

function addBands(a: RangedAmount, b: RangedAmount): RangedAmount {
  return { low: a.low + b.low, base: a.base + b.base, high: a.high + b.high };
}

function zeroBand(): RangedAmount {
  return { low: 0, base: 0, high: 0 };
}

/** Domain limits come from the cost-data file, never from code literals. */
function checkBounds(input: EngineInput, data: CostData): void {
  const bounds = data.inputBounds;
  const { property, scope } = input;

  if (!data.tiers.includes(scope.tier)) {
    throw new EngineInputError(`unknown finish tier: ${String(scope.tier)}`);
  }
  if (
    !Number.isFinite(scope.buildSqft) ||
    wholeDollars(scope.buildSqft) < bounds.minBuildSqft ||
    wholeDollars(scope.buildSqft) > bounds.maxBuildSqft
  ) {
    throw new EngineInputError(
      `buildSqft ${scope.buildSqft} outside [${bounds.minBuildSqft}, ${bounds.maxBuildSqft}]`,
    );
  }
  if (
    !Number.isFinite(property.lotSizeSqft) ||
    wholeDollars(property.lotSizeSqft) < bounds.minLotSizeSqft ||
    wholeDollars(property.lotSizeSqft) > bounds.maxLotSizeSqft
  ) {
    throw new EngineInputError(
      `lotSizeSqft ${property.lotSizeSqft} outside [${bounds.minLotSizeSqft}, ${bounds.maxLotSizeSqft}]`,
    );
  }
  if (
    !Number.isFinite(property.assessedLandValue) ||
    wholeDollars(property.assessedLandValue) < bounds.minAssessedLandValue ||
    wholeDollars(property.assessedLandValue) > bounds.maxAssessedLandValue
  ) {
    throw new EngineInputError('assessedLandValue outside configured bounds');
  }
  if (
    typeof property.zoning !== 'string' ||
    property.zoning.trim().length === 0 ||
    property.zoning.trim().length > bounds.maxZoningLength
  ) {
    throw new EngineInputError('zoning must be a non-empty code');
  }
}

/**
 * Run the estimate. Deterministic: no clock, no randomness, no I/O —
 * the result depends only on `input` and `costData`.
 */
export function createEstimate(input: EngineInput, costData: CostData): EstimateResult {
  checkBounds(input, costData);

  const buildSqft = wholeDollars(input.scope.buildSqft);
  const lotSizeSqft = wholeDollars(input.property.lotSizeSqft);
  const tier = input.scope.tier;
  const rows: CostRow[] = [];

  // Land — the City assessed value, fixed. No spread is applied: the
  // assessment is an input fact, not an estimated range. The breakdown row
  // carries a degenerate (zero-spread) range so row shapes stay uniform.
  const landValue = wholeDollars(input.property.assessedLandValue);
  const land: FixedAmount = { value: landValue };
  rows.push({
    key: 'land',
    label: 'Land (assessed value)',
    formula: 'assessedLandValue (fixed — City assessment, no spread)',
    range: { low: landValue, base: landValue, high: landValue },
  });

  // Hard costs — one row per category in data-file order (insertion order
  // is deterministic), each scaled by its configured input dimension.
  let hardTotal = zeroBand();
  for (const [key, category] of Object.entries(costData.hardCosts)) {
    const scale = category.scalesWith === 'lotSizeSqft' ? lotSizeSqft : buildSqft;
    const rowBand = band(scale * category.rates[tier], category.spread);
    hardTotal = addBands(hardTotal, rowBand);
    rows.push({ key: `hard.${key}`, label: category.label, formula: category.formula, range: rowBand });
  }

  // Soft costs — fractions of the hard-cost base total.
  let softTotal = zeroBand();
  for (const [key, category] of Object.entries(costData.softCosts)) {
    const rowBand = band(hardTotal.base * category.fraction, category.spread);
    softTotal = addBands(softTotal, rowBand);
    rows.push({ key: `soft.${key}`, label: category.label, formula: category.formula, range: rowBand });
  }

  // Contingency — fraction of (hard base + soft base).
  const contingencyBand = band(
    (hardTotal.base + softTotal.base) * costData.contingency.fraction,
    costData.contingency.spread,
  );
  rows.push({
    key: 'contingency',
    label: costData.contingency.label,
    formula: costData.contingency.formula,
    range: contingencyBand,
  });

  const build = addBands(addBands(hardTotal, softTotal), contingencyBand);
  const total = addBands(build, { low: landValue, base: landValue, high: landValue });

  return {
    costDataVersion: costData.version,
    calibrated: costData.calibrated,
    rows,
    totals: { build, land, total },
  };
}
