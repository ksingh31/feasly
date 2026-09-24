/**
 * Pure shape types for @feasly/cost-engine. No runtime code lives here.
 *
 * Money is whole CAD dollars (integers) — cents never leave the server.
 * Ranges are { low, base, high }; the engine NEVER emits per-sqft unit rates
 * or margin percentages (product rule — enforced by test/output-hygiene).
 */

/** Finish tiers the engine prices. Must match CostData.tiers. */
export type FinishTier = 'standard' | 'premium' | 'luxury';

export interface PropertyFacts {
  /** Assessed land value, whole CAD dollars. */
  readonly assessedLandValue: number;
  /** Lot size in square feet. */
  readonly lotSizeSqft: number;
  /** Zoning code, e.g. "R-C1". Used for future zoning-driven adjustments. */
  readonly zoning: string;
}

export interface BuildScope {
  /** Above-grade living area in square feet. */
  readonly buildSqft: number;
  readonly tier: FinishTier;
}

export interface EngineInput {
  readonly property: PropertyFacts;
  readonly scope: BuildScope;
}

/** Closed integer-dollar band. Invariant: low <= base <= high. */
export interface RangedAmount {
  readonly low: number;
  readonly base: number;
  readonly high: number;
}

export interface CostRow {
  readonly key: string;
  readonly label: string;
  /**
   * Symbolic formula referencing named coefficients only
   * (e.g. "buildSqft × hardCosts.foundation.rates[tier]") — never numeric
   * rates or percentages, so a row stays traceable without leaking
   * calibration figures.
   */
  readonly formula: string;
  readonly range: RangedAmount;
}

export interface EstimateTotals {
  readonly build: RangedAmount;
  readonly land: RangedAmount;
  readonly total: RangedAmount;
}

export interface EstimateResult {
  /** Pinned calibration-table version this estimate was computed with. */
  readonly costDataVersion: string;
  /** False until Karan's real cost Sheet calibrates a successor table. */
  readonly calibrated: boolean;
  readonly rows: readonly CostRow[];
  readonly totals: EstimateTotals;
}

/** Per-tier calibration rates for one hard-cost category. */
export interface TierRates {
  readonly standard: number;
  readonly premium: number;
  readonly luxury: number;
}

export interface HardCostCategory {
  readonly label: string;
  /** Which input dimension this category scales with. */
  readonly scalesWith: 'buildSqft' | 'lotSizeSqft';
  readonly formula: string;
  readonly rates: TierRates;
  /** Symmetric ± spread around the base, e.g. 0.12 = ±12%. */
  readonly spread: number;
}

export interface SoftCostCategory {
  readonly label: string;
  readonly formula: string;
  /** Fraction of the hard-cost base total. */
  readonly fraction: number;
  readonly spread: number;
}

export interface ContingencySpec {
  readonly label: string;
  readonly formula: string;
  /** Fraction of (hard-cost base + soft-cost base). */
  readonly fraction: number;
  readonly spread: number;
}

export interface InputBounds {
  readonly minBuildSqft: number;
  readonly maxBuildSqft: number;
  readonly minLotSizeSqft: number;
  readonly maxLotSizeSqft: number;
  readonly minAssessedLandValue: number;
  readonly maxAssessedLandValue: number;
  readonly maxZoningLength: number;
}

/**
 * Shape of a versioned cost-data file. EVERY tunable the engine uses lives
 * here — the engine source contains no calibration numbers, limits or
 * percentages (only arithmetic structure).
 */
export interface CostData {
  readonly _comment?: string;
  readonly version: string;
  readonly calibrated: boolean;
  readonly source: string;
  readonly notes: string;
  readonly tiers: readonly FinishTier[];
  readonly inputBounds: InputBounds;
  readonly hardCosts: Record<string, HardCostCategory>;
  readonly softCosts: Record<string, SoftCostCategory>;
  readonly contingency: ContingencySpec;
  /** Symmetric ± spread applied to the assessed land value. */
  readonly landSpread: number;
}

/** Thrown when an input violates the cost-data input bounds. */
export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineInputError';
  }
}
