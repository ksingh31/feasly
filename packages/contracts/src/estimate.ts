/**
 * Estimate contracts. The deterministic cost engine lives server-side; the
 * client receives real computed ranges both pre-gate and post-gate.
 *
 * Pre-gate and post-gate are separate types on purpose: `PreviewEstimateResponse`
 * carries the real computed figures but no cost breakdown (`rows` is empty),
 * so a route typed to return it cannot leak the itemized breakdown even by
 * accident. The UI renders pre-gate figures blurred (CSS) until the lead
 * gate unlocks — the blur is a lead-capture nudge, not a security boundary
 * (figures are readable in the API response by design, 2026-09-26).
 */
import type { CostRange, FixedFigure } from './common';

export type FinishTier = 'standard' | 'premium' | 'luxury';
export type GarageOption = 'none' | 'double' | 'triple';
export type BasementOption = 'unfinished' | 'finished';

/** Which estimate path produced the response. Absent on legacy new-build rows. */
export type ProjectType = 'new_build' | 'renovation' | 'comparison';

/** Renovation scope kinds the engine prices (RENO-01). */
export type RenoType = 'extensive' | 'addition' | 'basement' | 'combined';

export interface EstimateInputs {
  /** Living area in square feet. */
  readonly sqft: number;
  readonly tier: FinishTier;
  readonly garage: GarageOption;
  readonly basement: BasementOption;
}

/** Inputs captured for a renovation estimate (RENO-01). */
export interface RenoEstimateInputs {
  readonly projectType: 'renovation';
  readonly renoType: RenoType;
  /** Renovation area in square feet (additions bill at most 400). */
  readonly renoSqft: number;
  readonly tier: FinishTier;
  readonly underpinning: boolean;
}

/**
 * Per-figure display hint. The API returns real ranges post-gate; clients
 * blur `build`/`total` until the lead gate is verified. `land` is visible
 * where applicable — renovation estimates carry no land figure.
 */
export type VisibilityHint = 'visible' | 'blurred' | 'not_applicable';

export interface EstimateVisibility {
  readonly land: VisibilityHint;
  readonly build: VisibilityHint;
  readonly total: VisibilityHint;
}

export interface EstimateRequest extends EstimateInputs {
  readonly addressKey: string;
}

/** Renovation estimate request (RENO-01). Discriminated by projectType. */
export interface RenoEstimateRequest {
  readonly projectType: 'renovation';
  readonly addressKey: string;
  readonly renoType: RenoType;
  readonly renoSqft: number;
  readonly tier: FinishTier;
  readonly underpinning: boolean;
}

/** New-build estimate request (explicit discriminator for the union). */
export interface NewBuildEstimateRequest extends EstimateRequest {
  readonly projectType?: 'new_build';
}

/** Any estimate request — new build, renovation, or comparison (NBH-02). */
export type AnyEstimateRequest = NewBuildEstimateRequest | RenoEstimateRequest | ComparisonEstimateRequest;

/** Neighbourhood comparison estimate request (NBH-02). Discriminated by projectType. */
export interface ComparisonEstimateRequest {
  readonly projectType: 'comparison';
  /** 2–3 community slugs to compare. */
  readonly neighbourhoods: readonly string[];
  /** Above-grade living area in square feet (same for all communities). */
  readonly sqft: number;
  readonly tier: FinishTier;
}

/** One neighbourhood's figures in a comparison response (NBH-02). */
export interface ComparisonRowSet {
  readonly slug: string;
  /** True for exactly one row-set: the cheapest land by `low`. */
  readonly lowestLand: boolean;
  readonly land: CostRange;
  readonly build: CostRange;
  readonly total: CostRange;
  readonly visibility: EstimateVisibility;
}

/**
 * Post-gate neighbourhood comparison response (NBH-02).
 * Contains one row-set per community (2–3), not the single-figure shape.
 */
export interface ComparisonEstimateResponse {
  readonly estimateId: string;
  readonly projectType: 'comparison';
  readonly inputs: {
    readonly sqft: number;
    readonly tier: FinishTier;
  };
  readonly rowSets: readonly ComparisonRowSet[];
  readonly costDataVersion: string;
  readonly createdAt: string;
}

/** One breakdown line. Rendered only if the engine returned it — never invented. */
export interface CostRow {
  readonly key: string;
  readonly label: string;
  readonly range: CostRange;
}

/**
 * Pre-gate preview. Figures are the REAL computed ranges — the UI renders
 * them blurred (CSS `filter: blur()`) until the lead gate unlocks. Land is
 * the fixed City assessed value (`{ value: 0 }` for renovations), never a
 * range. Rows stay empty pre-gate — enforced by the type, not by convention.
 */
export interface PreviewEstimateResponse {
  readonly estimateId: string;
  readonly addressKey: string;
  readonly inputs: EstimateInputs;
  readonly figures: {
    readonly build: CostRange;
    readonly total: CostRange;
    readonly land: FixedFigure;
  };
  /** Always empty pre-gate — enforced by the type, not by convention. */
  readonly rows: readonly [];
  readonly costDataVersion: string;
  readonly createdAt: string;
}

/**
 * Post-gate estimate. Build and total are real ranges; land is a FIXED
 * figure (the City assessed value), never a range — assigning a CostRange
 * to it is a compile error. Adds the itemized cost breakdown (`rows`) that
 * the pre-gate preview omits. Snapshots and report figures only exist after
 * verification.
 */
export interface EstimateResponse {
  readonly estimateId: string;
  readonly addressKey: string;
  readonly inputs: EstimateInputs;
  readonly figures: {
    readonly build: CostRange;
    readonly total: CostRange;
    readonly land: FixedFigure;
  };
  readonly rows: readonly CostRow[];
  readonly costDataVersion: string;
  readonly createdAt: string;
  /**
   * Present on renovation estimates (RENO-01). New-build responses omit it —
   * their output shape is pinned by contract-conformance tests.
   */
  readonly projectType?: ProjectType;
  /** Renovation inputs, present only when projectType is 'renovation'. */
  readonly renoInputs?: RenoEstimateInputs;
  /**
   * Engine-authored assumptions (the only engine→narrative channel).
   * Present on renovation estimates; new-build responses omit it.
   */
  readonly assumptions?: readonly string[];
  /** Per-figure display hints. Present on renovation estimates. */
  readonly visibility?: EstimateVisibility;
  /**
   * Approved deterministic-math disclaimer (HRD-05). Every API estimate
   * response carries it verbatim — the same string the web report shows.
   * Byte-pinned by the HRD-05 banned-phrase/disclaimer check.
   */
  readonly disclaimer: string;
}

/**
 * The approved deterministic-math disclaimer, verbatim.
 * Single source of truth for the API surface; the web report uses the
 * identical string from app-config (`copy.narrativeDisclaimer`).
 */
export const ESTIMATE_DISCLAIMER =
  'Dollar figures are calculated deterministically from our cost model — not generated by AI.' as const;

/**
 * Response for POST /api/v1/estimates/{id}/narrative (consumer/06).
 *
 * The AI-generated narrative around the estimate's deterministic figures.
 * Always carries the verbatim footer (validated by `validateNarrative()`
 * before the worker persists it) — the same disclaimer string as
 * `ESTIMATE_DISCLAIMER`.
 */
export interface NarrativeResponse {
  readonly estimateId: string;
  /** The validated narrative text, including the verbatim footer. */
  readonly narrative: string;
  readonly narrativeGeneratedAt: string;
  /** True when returned from cache (no LLM call was made). */
  readonly cached: boolean;
}
