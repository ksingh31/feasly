/**
 * Builder report-contract actions (billing/01 charge path UI).
 *
 * All report-contract state lives in BuilderReportContractState — the
 * component dispatches and renders selectors, never calls the API directly.
 * The leads picker reads from BuilderState (tenant-scoped, already loaded
 * by the dashboard).
 */

/** Submits a signed-contract report for one of the builder's leads. */
export class SubmitReportContract {
  static readonly type = '[BuilderReportContract] Submit';
  constructor(
    public readonly leadId: string,
    /** Signed contract value in integer cents, EXCLUDING land. */
    public readonly contractValueCents: number,
    /** ISO-8601 datetime (with offset) of the contract signing. */
    public readonly contractSignedAt: string,
  ) {}
}

/** Returns the form to its pristine state after a successful report. */
export class ResetReportContract {
  static readonly type = '[BuilderReportContract] Reset';
}

/** Clears report-contract state (after logout). */
export class ClearReportContractState {
  static readonly type = '[BuilderReportContract] Clear';
}
