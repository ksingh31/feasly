/**
 * Estimate contracts. The deterministic cost engine lives server-side; the client
 * only ever receives ranges (post-gate) or blurred placeholders (pre-gate).
 *
 * Pre-gate and post-gate are separate types on purpose: `PreviewEstimateResponse`
 * cannot carry a single real dollar amount — not in `figures`, not in `rows` —
 * so a route typed to return it cannot leak figures even by accident.
 * (Backend: BE2-002 pre-gate blur guarantee, BE3-002 preview endpoint.)
 */
import type { BlurredFigure, CostRange } from './common';

export type FinishTier = 'standard' | 'premium' | 'luxury';
export type GarageOption = 'none' | 'double' | 'triple';
export type BasementOption = 'unfinished' | 'finished';

/** Which estimate path produced the response. Absent on legacy new-build rows. */
export type ProjectType = 'new_build' | 'renovation';

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

/** One breakdown line. Rendered only if the engine returned it — never invented. */
export interface CostRow {
  readonly key: string;
  readonly label: string;
  readonly range: CostRange;
}

/**
 * Pre-gate preview. Every figure is `{ blurred: true }` and rows is empty —
 * assigning a real CostRange anywhere in here is a compile error.
 */
export interface PreviewEstimateResponse {
  readonly estimateId: string;
  readonly addressKey: string;
  readonly inputs: EstimateInputs;
  readonly figures: {
    readonly build: BlurredFigure;
    readonly total: BlurredFigure;
    readonly land: BlurredFigure;
  };
  /** Always empty pre-gate — enforced by the type, not by convention. */
  readonly rows: readonly [];
  readonly costDataVersion: string;
  readonly createdAt: string;
}

/**
 * Post-gate estimate. Every figure is a real range — a blurred placeholder here
 * is a compile error. Snapshots and report figures only exist after verification.
 */
export interface EstimateResponse {
  readonly estimateId: string;
  readonly addressKey: string;
  readonly inputs: EstimateInputs;
  readonly figures: {
    readonly build: CostRange;
    readonly total: CostRange;
    readonly land: CostRange;
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
}
