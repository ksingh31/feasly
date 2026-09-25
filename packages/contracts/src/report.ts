/**
 * Report contracts. Snapshots are immutable — every re-run appends a new one.
 */
import type { CostRange, FixedFigure } from './common';
import type { CostRow, EstimateInputs, FinishTier, ProjectType, RenoEstimateInputs } from './estimate';

export interface ReportSnapshot {
  readonly snapshotId: string;
  readonly estimateId: string;
  readonly leadId: string;
  readonly inputs: EstimateInputs;
  /** Always real ranges here — snapshots exist only post-gate. */
  readonly buildRange: CostRange;
  readonly totalRange: CostRange;
  /** Fixed City assessed land value — never a range. Zero/not-applicable for reno. */
  readonly landValue: FixedFigure;
  readonly rows: readonly CostRow[];
  readonly narrative: string;
  readonly preparedAt: string;
  /** Monotonic per estimateId. */
  readonly version: number;
  /**
   * Set when an old magic link resolved to a newer snapshot (consumer/02).
   * The report header shows "Updated {date}" using this value.
   * Absent for first-view reports (no update to display).
   */
  readonly updatedAt?: string;
  /**
   * Present on renovation snapshots (RENO-01). New-build snapshots omit it.
   */
  readonly projectType?: ProjectType;
  /** Renovation inputs, present only when projectType is 'renovation'. */
  readonly renoInputs?: RenoEstimateInputs;
  /**
   * Engine-authored assumptions. Present on renovation snapshots.
   */
  readonly assumptions?: readonly string[];
}

/** What the verified report fetch returns. */
export type GetReportResponse = ReportSnapshot;

export interface TierRevisionRequest {
  readonly tier?: FinishTier;
  readonly sqft?: number;
}

export type TierRevisionResponse = ReportSnapshot;
