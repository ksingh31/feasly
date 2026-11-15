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
 * - Build bands (rows + totals) round to the table's `roundTo` granularity
 *   (#581; $1,000 from v0.4.0). The land figure is the City assessment and
 *   stays exact, so `total === land + build` holds to the dollar. Tables
 *   without `roundTo` (v0.1–v0.3) keep whole-dollar output, unchanged.
 */
import {
  EngineInputError,
  type CostData,
  type CostRow,
  type EngineInput,
  type EstimateResult,
  type FinishTier,
  type FixedAmount,
  type RangedAmount,
} from './types';
import { addBands, band, outputGranularity, wholeDollars, zeroBand } from './bands';

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
  // Lot size is NEVER a blocking bound (Karan, 2026-09-28): any lot prices,
  // quoted off the house size. Bigger-lot adjustments (uplift, landscaping
  // notes) are decided at cost-sheet calibration time, not here. Only a
  // non-finite value (missing/corrupt data) is rejected — it can't price.
  if (!Number.isFinite(property.lotSizeSqft)) {
    throw new EngineInputError('lotSizeSqft must be a finite number');
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
/**
 * Calculates the build-cost band (hard + soft + contingency) for a given
 * build size, lot size, and finish tier. Exported for reuse by the
 * neighbourhood comparison engine (NBH-02), which needs the build portion
 * without the property-specific land assessment.
 *
 * Pure function of (buildSqft, lotSizeSqft, tier, costData).
 */
export function calculateBuildBand(
  buildSqft: number,
  lotSizeSqft: number,
  tier: FinishTier,
  costData: CostData,
): RangedAmount {
  const buildSqftWhole = wholeDollars(buildSqft);
  const lotSizeSqftWhole = wholeDollars(lotSizeSqft);
  const g = outputGranularity(costData);

  // Hard costs — one row per category in data-file order (insertion order
  // is deterministic), each scaled by its configured input dimension.
  let hardTotal = zeroBand();
  for (const [, category] of Object.entries(costData.hardCosts)) {
    const scale = category.scalesWith === 'lotSizeSqft' ? lotSizeSqftWhole : buildSqftWhole;
    const rowBand = band(scale * category.rates[tier], category.spread, g);
    hardTotal = addBands(hardTotal, rowBand);
  }

  // Soft costs — fractions of the hard-cost base total.
  let softTotal = zeroBand();
  for (const [, category] of Object.entries(costData.softCosts)) {
    const rowBand = band(hardTotal.base * category.fraction, category.spread, g);
    softTotal = addBands(softTotal, rowBand);
  }

  // Contingency — fraction of (hard base + soft base).
  const contingencyBand = band(
    (hardTotal.base + softTotal.base) * costData.contingency.fraction,
    costData.contingency.spread,
    g,
  );

  return addBands(addBands(hardTotal, softTotal), contingencyBand);
}

export function createEstimate(input: EngineInput, costData: CostData): EstimateResult {
  checkBounds(input, costData);

  const buildSqft = wholeDollars(input.scope.buildSqft);
  const lotSizeSqft = wholeDollars(input.property.lotSizeSqft);
  const tier = input.scope.tier;
  const g = outputGranularity(costData);
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
    const rowBand = band(scale * category.rates[tier], category.spread, g);
    hardTotal = addBands(hardTotal, rowBand);
    rows.push({ key: `hard.${key}`, label: category.label, formula: category.formula, range: rowBand });
  }

  // Soft costs — fractions of the hard-cost base total.
  let softTotal = zeroBand();
  for (const [key, category] of Object.entries(costData.softCosts)) {
    const rowBand = band(hardTotal.base * category.fraction, category.spread, g);
    softTotal = addBands(softTotal, rowBand);
    rows.push({ key: `soft.${key}`, label: category.label, formula: category.formula, range: rowBand });
  }

  // Contingency — fraction of (hard base + soft base).
  const contingencyBand = band(
    (hardTotal.base + softTotal.base) * costData.contingency.fraction,
    costData.contingency.spread,
    g,
  );
  rows.push({
    key: 'contingency',
    label: costData.contingency.label,
    formula: costData.contingency.formula,
    range: contingencyBand,
  });

  const build = calculateBuildBand(buildSqft, lotSizeSqft, tier, costData);
  const total = addBands(build, { low: landValue, base: landValue, high: landValue });

  return {
    costDataVersion: costData.version,
    calibrated: costData.calibrated,
    rows,
    totals: { build, land, total },
  };
}
