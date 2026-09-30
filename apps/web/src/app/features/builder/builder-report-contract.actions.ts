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

/** Clears report-contract state (after logout). */
export class ClearReportContractState {
  static readonly type = '[BuilderReportContract] Clear';
}

/**
 * Loads the org's negotiated commission rate (percent) for the live
 * preview (billing/08). The preview falls back to the 1% default while
 * the rate loads or when the fetch fails — the figure is display-only;
 * the backend computes the billed amount.
 */
export class LoadCommissionRate {
  static readonly type = '[BuilderReportContract] Load commission rate';
}
