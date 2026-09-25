/**
 * Neighbourhood comparison branch (NBH-02).
 *
 * Compares 2–3 communities by calculating the build cost once (same house
 * design across all communities) and deriving land from each community's
 * average lot size.
 *
 * Pure function: no I/O, no clock, no env — all inputs are parameters.
 */
import {
  EngineInputError,
  type ComparisonInput,
  type ComparisonResult,
  type ComparisonRowSet,
  type CostData,
  type RangedAmount,
} from './types';
import { calculateBuildBand } from './engine';

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

/**
 * Run the neighbourhood comparison.
 *
 * For each community:
 * - Land = avgLotSqft × comparison.landRatePerSqft ± comparison.landSpread
 * - Build = standard engine build (hard + soft + contingency) — identical
 *   across communities (same house design, same sqft, same tier)
 * - Total = land + build (componentwise)
 *
 * Exactly one row-set carries lowestLand: true — the cheapest by land.low.
 * Ties go to the first slug in input order (documented, deterministic).
 *
 * Throws EngineInputError for:
 * - neighbourhoods.length not in [2, 3]
 * - unknown tier (via the underlying engine)
 * - null avgLotSqft for any slug (data incomplete)
 * - buildSqft outside the cost-data bounds (via the underlying engine)
 */
export function createComparisonEstimate(
  input: ComparisonInput,
  costData: CostData,
): ComparisonResult {
  const { neighbourhoods, buildSqft, tier, avgLotSqftBySlug } = input;

  // Validate neighbourhood count.
  if (neighbourhoods.length < 2 || neighbourhoods.length > 3) {
    throw new EngineInputError(
      `comparison requires 2–3 neighbourhoods, got ${neighbourhoods.length}`,
    );
  }

  // Validate tier.
  if (!costData.tiers.includes(tier)) {
    throw new EngineInputError(`unknown finish tier: ${String(tier)}`);
  }

  // Validate buildSqft bounds (mirrors engine.ts checkBounds for scope).
  const bounds = costData.inputBounds;
  if (
    !Number.isFinite(buildSqft) ||
    Math.round(buildSqft) < bounds.minBuildSqft ||
    Math.round(buildSqft) > bounds.maxBuildSqft
  ) {
    throw new EngineInputError(
      `buildSqft ${buildSqft} outside [${bounds.minBuildSqft}, ${bounds.maxBuildSqft}]`,
    );
  }

  // Build: calculate once — identical across communities (same house).
  // Uses lotSizeSqft=0 since site-prep (the only lot-scaled category) is
  // not meaningful for a cross-community comparison; land already accounts
  // for lot size differences.
  const build = calculateBuildBand(buildSqft, 0, tier, costData);

  // Build one row-set per community.
  const rowSets: ComparisonRowSet[] = [];
  for (const slug of neighbourhoods) {
    const avgLotSqft = avgLotSqftBySlug[slug];
    if (avgLotSqft === null || avgLotSqft === undefined) {
      throw new EngineInputError(
        `community '${slug}' has no lot size data (avgLotSqft is null)`,
      );
    }
    if (!Number.isFinite(avgLotSqft) || avgLotSqft <= 0) {
      throw new EngineInputError(
        `community '${slug}' has invalid lot size: ${String(avgLotSqft)}`,
      );
    }

    // Land: avgLotSqft × landRatePerSqft ± landSpread.
    const landBase = wholeDollars(avgLotSqft) * costData.comparison.landRatePerSqft;
    const land = band(landBase, costData.comparison.landSpread);

    // Total: land + build (componentwise).
    const total = addBands(land, build);

    rowSets.push({
      slug,
      lowestLand: false, // set below after comparing all
      land,
      build,
      total,
      visibility: {
        land: 'visible',
        build: 'blurred',
        total: 'blurred',
      },
    });
  }

  // Flag the cheapest land by `low`. Ties → first slug wins (deterministic).
  let cheapestIdx = 0;
  for (let i = 1; i < rowSets.length; i++) {
    if (rowSets[i].land.low < rowSets[cheapestIdx].land.low) {
      cheapestIdx = i;
    }
  }
  const flagged = rowSets.map((rs, idx) => ({
    ...rs,
    lowestLand: idx === cheapestIdx,
  }));

  return {
    costDataVersion: costData.version,
    calibrated: costData.calibrated,
    rowSets: flagged,
  };
}
