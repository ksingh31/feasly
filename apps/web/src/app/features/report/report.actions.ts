/**
 * Report NGXS actions (M1).
 *
 * Integration contract for the lead-gate / analyzing flow: after magic-link
 * verification, dispatch `SetReportToken` with the report token and navigate
 * to `/estimate/report`. The page then fetches the verified snapshot itself.
 * Pre-gate, the page dispatches `LoadPreview` and renders blurred figures.
 */
export class LoadPreview {
  static readonly type = '[Report] Load preview';
}

export class SetReportToken {
  static readonly type = '[Report] Set report token';
  constructor(public readonly reportToken: string) {}
}

export class UnlockReport {
  static readonly type = '[Report] Unlock report';
}

export class ReviseReport {
  static readonly type = '[Report] Revise report';
  /**
   * Live revision input. The redesigned report drives this with sqft only —
   * the sqft stepper dispatches through a 400 ms trailing debounce, so rapid
   * taps coalesce into one backend revision. The tier slot stays for API
   * compatibility (the contract still accepts a tier revision) but the report
   * UI no longer offers a tier switcher: the finish tier is display-only.
   */
  constructor(
    public readonly tier?: 'standard' | 'premium' | 'luxury',
    public readonly sqft?: number,
  ) {}
}

export class ClearReport {
  static readonly type = '[Report] Clear';
}
