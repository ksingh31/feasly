/**
 * Assessment detail + year-by-year history (#695).
 *
 * Composes the shared property read path (#756) — the current-year record
 * from dataset `4bsw-nn7w` and the City's Historical Property Assessments
 * (`4ur7-wsgc`) — into one `PropertyAssessmentResponse` for the
 * assessed-value page. Assessed value is always free and ungated (owner,
 * 2026-11-15).
 *
 * - Degrade, never fail: a history outage (or an address with no history,
 *   e.g. a new subdivision) returns the current record with `history: []`
 *   and `historyAvailable: false`. Only a current-year failure fails the
 *   request (503 DEPENDENCY_UNAVAILABLE / 404, same contract as lookup).
 * - Never refuses on property type: non-residential and multi-unit parcels
 *   get a normal response.
 * - History shaping (pure, `buildAssessmentHistory`): when the current
 *   record's roll number matches history rows (compared without leading
 *   zeros — the history dataset drops them), only that parcel's rows are
 *   used; otherwise every row at the address. One entry per roll year
 *   (highest value wins, same rule as the current-year lookup), the current
 *   roll year from the current-year dataset (so the series has no gap),
 *   newest first, integers.
 * - No PII in logs: only the error class and the correlation id.
 */
import type {
  AssessmentHistoryPoint,
  PropertyAssessmentResponse,
  PropertyRecord,
} from '@feasly/contracts';
import { detectCoverageSignal } from '../lib/coverage';
import type {
  AssessmentHistoryRow,
  GetPropertyOptions,
  PropertyDetailReader,
} from './property.service';

export interface AssessmentService {
  /**
   * Current record + history for an exact address key.
   * @throws HttpError 404 ADDRESS_NOT_FOUND / OUT_OF_COVERAGE (as lookup).
   * @throws HttpError 503 DEPENDENCY_UNAVAILABLE when the current-year City
   *   data is down. A history outage never throws.
   */
  getAssessment(addressKey: string, options?: GetPropertyOptions): Promise<PropertyAssessmentResponse>;
}

export interface AssessmentServiceDeps {
  readonly properties: PropertyDetailReader;
  /** Warning sink for the history fallback (default console.warn). */
  readonly logWarning?: (message: string) => void;
}

/**
 * Shapes raw history rows into the published series. Returns [] when there
 * are no usable rows (the caller reports `historyAvailable: false`).
 */
export function buildAssessmentHistory(
  rows: readonly AssessmentHistoryRow[],
  current: PropertyRecord,
  currentRollNumber: string | null,
): AssessmentHistoryPoint[] {
  if (rows.length === 0) return [];
  const sameParcel = currentRollNumber
    ? rows.filter((row) => row.rollNumber === currentRollNumber)
    : [];
  const source = sameParcel.length > 0 ? sameParcel : rows;
  const byYear = new Map<number, number>();
  for (const row of source) {
    const value = Math.round(row.assessedValue);
    const existing = byYear.get(row.rollYear);
    if (existing === undefined || value > existing) byYear.set(row.rollYear, value);
  }
  // The current-year dataset is authoritative for its own roll year; skip it
  // when that year was inferred rather than read from the City (#622).
  if (!current.assessmentYearInferred) {
    byYear.set(current.assessmentYear, Math.round(current.assessedValue));
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rollYear, assessedValue]) => ({ rollYear, assessedValue }));
}

/** Error class only — never the message (it may carry the request URL). */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createAssessmentService(deps: AssessmentServiceDeps): AssessmentService {
  const logWarning = deps.logWarning ?? ((message: string) => console.warn(message));

  return {
    async getAssessment(
      addressKey: string,
      options: GetPropertyOptions = {},
    ): Promise<PropertyAssessmentResponse> {
      const key = addressKey.trim();
      // Start the history read alongside the current record, except for keys
      // the property read rejects without a City call (empty/out-of-coverage).
      const historyPromise: Promise<readonly AssessmentHistoryRow[] | null> =
        key && detectCoverageSignal(key) !== 'out-of-coverage'
          ? deps.properties.getAssessmentHistory(key).catch((error: unknown) => {
              logWarning(
                `[assessment] history unavailable (${errorClass(error)}); ` +
                  `returning the current record only. correlationId=${options.correlationId ?? 'none'}`,
              );
              return null;
            })
          : Promise.resolve(null);
      const detail = await deps.properties.getPropertyDetail(key, options);
      const rows = await historyPromise;
      const history = rows ? buildAssessmentHistory(rows, detail.property, detail.rollNumber) : [];
      return {
        property: detail.property,
        cityRecordUpdatedOn: detail.cityRecordUpdatedOn,
        propertyClassLabel: detail.propertyClassLabel,
        history,
        historyAvailable: history.length > 0,
      };
    },
  };
}
