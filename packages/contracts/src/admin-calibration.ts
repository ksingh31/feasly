/**
 * Admin calibration-console contracts (admin/09).
 *
 * Backend: `GET /api/v1/admin/calibration` (admin-auth) returns the current
 * cost-data version, frozen-params summary, calibration report
 * (per-house actuals vs. engine output, error distribution, sample size +
 * small-sample warning), and import history.
 *
 * All amounts are integer cents. The UI formats to CAD dollars — no float
 * math in display.
 */

/** One house in the calibration report: actuals vs. engine output. */
export interface CalibrationHouseReport {
  /** House identifier (e.g. "House A"). Never contains PII. */
  readonly houseId: string;
  /** Actual total build cost in cents. */
  readonly actualTotalCents: number;
  /** Engine output total in cents (pinned to the report's costDataVersion). */
  readonly engineTotalCents: number;
  /**
   * Signed error as a fraction: (engine - actual) / actual.
   * Positive = engine over-estimated.
   */
  readonly errorFraction: number;
}

/** Error-distribution buckets for the calibration report chart. */
export interface CalibrationErrorDistribution {
  /** Bucket labels, e.g. ["-20% to -10%", "-10% to 0%", ...]. */
  readonly buckets: readonly string[];
  /** House counts per bucket, parallel to `buckets`. */
  readonly counts: readonly number[];
}

/**
 * The calibration report. Until Karan's cost Sheet arrives and the first
 * import runs, `houses` is empty and `sampleSize` is 0 — the UI must show
 * the small-sample warning (and the "uncalibrated" state) instead of
 * pretending the numbers are calibrated.
 */
export interface CalibrationReport {
  /** Cost-data version this report was computed against. */
  readonly costDataVersion: string;
  /** Per-house actuals vs. engine output. Empty until the first import. */
  readonly houses: readonly CalibrationHouseReport[];
  /** Error distribution across houses. Empty buckets until the first import. */
  readonly errorDistribution: CalibrationErrorDistribution;
  /** Number of houses in the report. */
  readonly sampleSize: number;
  /**
   * Exact small-sample warning copy. Always present when sampleSize < 10;
   * the plan mandates it — 3–4 houses is a small sample and the report
   * must say so.
   */
  readonly smallSampleWarning: string | null;
  /** Mean absolute error as a fraction, or null when sampleSize is 0. */
  readonly meanAbsoluteErrorFraction: number | null;
}

/** Frozen-params summary for one cost-data version. */
export interface CalibrationVersionInfo {
  /** Version string, e.g. "v0.3.0-unclibrated" or "v1.0.0-calgary". */
  readonly version: string;
  /** True once a real calibration import has been frozen. */
  readonly calibrated: boolean;
  /** True once the freeze command has snapshotted this version (immutable). */
  readonly frozen: boolean;
  /** Human-readable source, e.g. "placeholder stand-ins" or "Karan's cost Sheet". */
  readonly source: string;
  /** Free-text notes about this version. */
  readonly notes: string;
  /** Number of hard-cost categories in this version. */
  readonly hardCostCategories: number;
  /** Number of soft-cost categories in this version. */
  readonly softCostCategories: number;
  /** Finish tiers in this version, e.g. ["builder", "mid", "luxury"]. */
  readonly tiers: readonly string[];
}

/** One row of the calibration import history. */
export interface CalibrationImportHistoryItem {
  /** Import identifier. */
  readonly id: string;
  /** ISO 8601 timestamp of the import. */
  readonly importedAt: string;
  /** Cost-data version the import produced. */
  readonly version: string;
  /** Number of houses in the import. */
  readonly houseCount: number;
  /** Who ran the import (admin email). */
  readonly importedBy: string;
  /** 'frozen' | 'draft' | 'superseded'. */
  readonly status: 'frozen' | 'draft' | 'superseded';
}

/** Response for `GET /api/v1/admin/calibration`. */
export interface AdminCalibrationResponse {
  /** The version the engine currently serves estimates with. */
  readonly current: CalibrationVersionInfo;
  /** The calibration report for the current version. */
  readonly report: CalibrationReport;
  /** Import history, newest first. Empty until the first import. */
  readonly importHistory: readonly CalibrationImportHistoryItem[];
  /**
   * True when a v2 draft import exists (started via "Start v2 import").
   * The frozen v1 is never touched by the draft.
   */
  readonly hasDraftV2: boolean;
}
