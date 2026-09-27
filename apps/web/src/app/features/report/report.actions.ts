/**
 * Report NGXS actions (M1).
 *
 * Integration contract for the lead-gate / analyzing flow:
 * - magic-link verification: dispatch `SetReportToken` with the report
 *   token and navigate to `/estimate/report` — the page fetches the
 *   verified snapshot itself (`UnlockReport`);
 * - same-session post-gate (Karan directive 2026-09-27): the page dispatches
 *   `LoadLeadEstimate` and renders the full report immediately from the
 *   public estimate endpoint — no magic-link round-trip;
 * - pre-gate: the page dispatches `LoadPreview` and renders blurred figures.
 */
export class LoadPreview {
  static readonly type = '[Report] Load preview';
}

export class SetReportToken {
  static readonly type = '[Report] Set report token';
  constructor(public readonly reportToken: string) {}
}

/**
 * Marks the current report session as a partner-share view (partner-share
 * redemption). The report page renders read-only in this mode: no share
 * form, no callback form, no size stepper — the backend also rejects those
 * actions for partner tokens with 403. Reset by SetReportToken (a fresh
 * owner link) and ClearReport.
 */
export class SetPartnerView {
  static readonly type = '[Report] Set partner view';
}

export class UnlockReport {
  static readonly type = '[Report] Unlock report';
}

/**
 * Immediate post-gate unlock (Karan directive 2026-09-27): after the lead
 * gate is submitted, the report unlocks WITHOUT the magic-link round-trip.
 * The handler runs the PUBLIC estimate endpoint (auth:none — no API change,
 * no new data exposure; the pre-gate blur was a nudge, not a boundary) and
 * maps the full response (figures + rows) onto the report snapshot the page
 * renders. The token-gated extras (AI narrative, token revise, share,
 * callback) stay behind the magic-link email, whose role is now
 * return-access on other devices.
 */
export class LoadLeadEstimate {
  static readonly type = '[Report] Load lead estimate';
}

export class ReviseReport {
  static readonly type = '[Report] Revise report';
  /**
   * Live revision input. The report drives this from the sqft stepper, which
   * dispatches through a trailing debounce from config, so rapid changes
   * coalesce into one backend revision. `cancelUncompleted` on the handler
   * gives last-write-wins, so a stale in-flight response can never overwrite
   * a newer snapshot. (consumer/04 AC8: the tier what-if toggle was removed
   * from the report page — the tier is display-only there. The optional tier
   * parameter remains for other revise callers.)
   */
  constructor(
    public readonly tier?: 'standard' | 'premium' | 'luxury',
    public readonly sqft?: number,
  ) {}
}

export class ClearReport {
  static readonly type = '[Report] Clear';
}
