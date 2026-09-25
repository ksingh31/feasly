/**
 * Admin estimate-lookup contracts (admin/03).
 *
 * Read-only snapshot view: Karan pastes an estimate ID and sees exactly what
 * the homeowner saw — inputs, ranges, cost-data version, snapshot history.
 * No mutation shapes exist by design (AC3).
 */
import type { CostRange, FixedFigure } from './common';
import type { CostRow, EstimateInputs, ProjectType } from './estimate';

/**
 * One entry in the snapshot timeline: every estimate for the same
 * address+email household, newest first. Each links to its own
 * `GET /api/v1/admin/estimates/{id}` lookup.
 */
export interface AdminEstimateSnapshotRef {
  /** The estimate's own lookup id. */
  readonly id: string;
  readonly createdAt: string;
}

/**
 * `GET /api/v1/admin/estimates/{id}` response.
 *
 * `outputs` uses the report's field names (`buildRange`/`totalRange`/
 * `landValue`) so it deep-equals the consumer `ReportSnapshot` figures for
 * the same estimate (AC1) — same serializer shape, no drift.
 */
export interface AdminEstimateDetail {
  readonly id: string;
  readonly projectType: ProjectType;
  readonly inputs: EstimateInputs;
  readonly outputs: {
    readonly buildRange: CostRange;
    readonly totalRange: CostRange;
    /** Fixed City assessed land value — never a range. */
    readonly landValue: FixedFigure;
  };
  /** Breakdown rows as returned by the engine. */
  readonly rows: readonly CostRow[];
  readonly costDataVersion: string;
  /**
   * Present only when a narrative was generated for this estimate. The
   * backend never invents one — null when the estimate has none.
   */
  readonly narrative: string | null;
  readonly createdAt: string;
  /** The lead currently pointing at this estimate, if the gate completed. */
  readonly linkedLeadId: string | null;
  /** All snapshots for the address+email, newest first (AC4). */
  readonly snapshots: readonly AdminEstimateSnapshotRef[];
}
