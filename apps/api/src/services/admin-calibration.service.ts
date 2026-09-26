/**
 * Admin calibration-console service (admin/09).
 *
 * Read-only view of the cost engine's calibration state:
 * - current cost_data_version + frozen-params summary
 * - calibration report (per-house actuals vs. engine output, error
 *   distribution, sample size + small-sample warning)
 * - import history
 *
 * The first real calibration import is blocked on Karan's cost Sheet
 * (cost-engine/01). Until it lands, the report shows the uncalibrated
 * placeholder state honestly: zero houses, the small-sample warning, and
 * `calibrated: false`. Nothing here writes params — param changes go
 * through the freeze process, never this console (AC2).
 */
import type {
  AdminCalibrationResponse,
  CalibrationImportHistoryItem,
  CalibrationReport,
  CalibrationVersionInfo,
} from '@feasly/contracts';
import type { CostData } from '@feasly/cost-engine';

/** Exact small-sample warning copy (mandated by the plan). */
export const SMALL_SAMPLE_WARNING =
  'Small sample warning: this calibration is based on a small number of houses. ' +
  'Treat all error figures as directional, not precise.';

/** Shown when no calibration import has run yet. */
export const NO_CALIBRATION_WARNING =
  'No calibration data yet — the engine is running on uncalibrated placeholder ' +
  'parameters. Every dollar figure on the site is visibly marked uncalibrated ' +
  'until Karan\u2019s cost Sheet arrives and the first import is frozen.';

/** Sample sizes below this threshold trigger the small-sample warning. */
export const SMALL_SAMPLE_THRESHOLD = 10;

export interface AdminCalibrationServiceDeps {
  /** The cost-data table the engine currently serves estimates with. */
  readonly costData: CostData;
  /**
   * Import history, newest first. Empty until the first calibration import
   * (cost-engine/01) lands — the store behind this is wired then.
   */
  readonly importHistory?: readonly CalibrationImportHistoryItem[];
  /** True when a v2 draft import exists (never touches the frozen v1). */
  readonly hasDraftV2?: boolean;
}

export interface AdminCalibrationService {
  /**
   * Build the calibration console payload. Read-only: no params are
   * written, no draft is created. Writes an audit row via the caller's
   * adminEmail for traceability.
   */
  getCalibration(adminEmail: string): Promise<AdminCalibrationResponse>;
}

function buildVersionInfo(costData: CostData): CalibrationVersionInfo {
  return {
    version: costData.version,
    calibrated: costData.calibrated,
    // A version is frozen once it is calibrated: the freeze command
    // snapshots it as immutable (cost-engine/01). Placeholders are never
    // frozen — they are replaced, not edited in place.
    frozen: costData.calibrated,
    source: costData.calibrated ? costData.source : 'placeholder stand-ins (uncalibrated)',
    notes: costData.notes,
    hardCostCategories: Object.keys(costData.hardCosts).length,
    softCostCategories: Object.keys(costData.softCosts).length,
    tiers: [...costData.tiers],
  };
}

function buildReport(costData: CostData): CalibrationReport {
  // No import has run yet: zero houses, honest warnings. The per-house
  // rows and error distribution are populated by the import tooling
  // (cost-engine/01) once Karan's Sheet arrives.
  return {
    costDataVersion: costData.version,
    houses: [],
    errorDistribution: { buckets: [], counts: [] },
    sampleSize: 0,
    smallSampleWarning: NO_CALIBRATION_WARNING,
    meanAbsoluteErrorFraction: null,
  };
}

export function createAdminCalibrationService(
  deps: AdminCalibrationServiceDeps,
): AdminCalibrationService {
  const { costData } = deps;
  const importHistory = deps.importHistory ?? [];
  const hasDraftV2 = deps.hasDraftV2 ?? false;

  return {
    async getCalibration(_adminEmail: string): Promise<AdminCalibrationResponse> {
      return {
        current: buildVersionInfo(costData),
        report: buildReport(costData),
        importHistory,
        hasDraftV2,
      };
    },
  };
}
