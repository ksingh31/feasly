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

/** Renovation scope kinds the engine prices (RENO-01). */
export type RenoType = 'extensive' | 'addition' | 'basement' | 'combined';

/** Component keys with their own calibration rows ('combined' sums them). */
export type RenoComponentKey = 'extensive' | 'addition' | 'basement';

export interface BuildScope {
  /** Above-grade living area in square feet. */
  readonly buildSqft: number;
  readonly tier: FinishTier;
}

/** Input to the renovation estimate branch (RENO-01). */
export interface RenoInput {
  readonly renoType: RenoType;
  /** Renovation area in square feet. */
  readonly renoSqft: number;
  readonly tier: FinishTier;
  /**
   * Foundation underpinning. Only meaningful for `basement`/`combined`
   * inputs — ignored (not an error) for other reno types.
   */
  readonly underpinning: boolean;
}

/** Result of the renovation estimate branch (RENO-01). */
export interface RenoEstimateResult {
  /** Pinned calibration-table version this estimate was computed with. */
  readonly costDataVersion: string;
  /** False until Karan's real cost Sheet calibrates a successor table. */
  readonly calibrated: boolean;
  /** One row per priced component (underpinning is its own row). */
  readonly rows: readonly CostRow[];
  /** Sum of the component ranges, componentwise. */
  readonly total: RangedAmount;
  /**
   * Engine-authored assumptions — the only engine→narrative channel.
   * Includes the draft-placeholder note while reno rates are uncalibrated.
   */
  readonly assumptions: readonly string[];
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

/**
 * A single fixed CAD amount — not a range. Used for the assessed land value,
 * which is a City fact, not an estimated range.
 */
export interface FixedAmount {
  readonly value: number;
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
  /**
   * Fixed City assessed land value — no spread is ever applied. The
   * assessment is an input fact, not an estimated range.
   */
  readonly land: FixedAmount;
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

/** One priced renovation component (RENO-01). */
export interface RenoComponentSpec {
  readonly label: string;
  readonly formula: string;
  readonly rates: TierRates;
}

/** Flat (unbanded) underpinning allowance (RENO-01). */
export interface RenoUnderpinningSpec {
  readonly label: string;
  readonly formula: string;
  readonly low: number;
  readonly high: number;
}

export interface RenoInputBounds {
  readonly minRenoSqft: number;
  readonly maxRenoSqft: number;
}

/**
 * Renovation calibration section (RENO-01). Rates are draft placeholders
 * until Karan's cost Sheet calibrates a successor table — `draft: true`
 * marks that, and the API refuses reno requests on draft tables unless
 * COST_ENGINE_ALLOW_DRAFT is set (never in production).
 */
export interface RenoSpec {
  /** True while the reno rates are uncalibrated stand-ins. */
  readonly draft: boolean;
  readonly draftNote: string;
  readonly components: Record<RenoComponentKey, RenoComponentSpec>;
  /** Billable-area ceiling for additions (400). */
  readonly additionCapSqft: number;
  readonly underpinning: RenoUnderpinningSpec;
  /** Asymmetric reno band: low = base × lowFactor, high = base × highFactor. */
  readonly lowFactor: number;
  readonly highFactor: number;
  /** Renovation figures round to this dollar granularity (1000). */
  readonly roundTo: number;
  readonly inputBounds: RenoInputBounds;
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
  /** Renovation calibration section (RENO-01). */
  readonly reno: RenoSpec;
}

/** Thrown when an input violates the cost-data input bounds. */
export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineInputError';
  }
}
