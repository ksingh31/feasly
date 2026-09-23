/**
 * Estimate contracts. The deterministic cost engine lives server-side; the client
 * only ever receives ranges (post-gate) or blurred placeholders (pre-gate).
 */
import type { CostRange, Figure } from './common';

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

export interface EstimateFigures {
  readonly build: Figure;
  readonly total: Figure;
  readonly land: Figure;
}

export interface EstimateResponse {
  readonly estimateId: string;
  readonly addressKey: string;
  readonly inputs: EstimateInputs;
  /** Pre-gate every figure is `{ blurred: true }`; rows is empty. */
  readonly figures: EstimateFigures;
  readonly rows: readonly CostRow[];
  readonly costDataVersion: string;
  readonly createdAt: string;
}
