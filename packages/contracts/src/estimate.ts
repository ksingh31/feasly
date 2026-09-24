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

export interface EstimateInputs {
  /** Living area in square feet. */
  readonly sqft: number;
  readonly tier: FinishTier;
  readonly garage: GarageOption;
  readonly basement: BasementOption;
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
}
