/**
 * Report contracts. Snapshots are immutable — every re-run appends a new one.
 */
import type { CostRange } from './common';
import type { CostRow, EstimateInputs, FinishTier } from './estimate';

export interface ReportSnapshot {
  readonly snapshotId: string;
  readonly estimateId: string;
  readonly leadId: string;
  readonly inputs: EstimateInputs;
  /** Always real ranges here — snapshots exist only post-gate. */
  readonly buildRange: CostRange;
  readonly totalRange: CostRange;
  readonly landRange: CostRange;
  readonly rows: readonly CostRow[];
  readonly narrative: string;
  readonly preparedAt: string;
  /** Monotonic per estimateId. */
  readonly version: number;
}

/** What the verified report fetch returns. */
export type GetReportResponse = ReportSnapshot;

export interface TierRevisionRequest {
  readonly tier?: FinishTier;
  readonly sqft?: number;
}

export type TierRevisionResponse = ReportSnapshot;
