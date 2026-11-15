/** Which quarantine decision is being applied. */
export type QuarantineDecision = 'approve' | 'discard';

/**
 * Reload the quarantine queue from the first page. `search` narrows by
 * name, email or address (empty = the whole queue, which also refreshes
 * the sidebar badge count).
 */
export class LoadQuarantine {
  static readonly type = '[AdminQuarantine] Load';
  constructor(readonly search = '') {}
}

/** Refresh only the whole-queue size (sidebar badge). Failures are silent. */
export class RefreshQuarantineCount {
  static readonly type = '[AdminQuarantine] Refresh count';
}

/** Fetch the next cursor page and append it. */
export class LoadMoreQuarantine {
  static readonly type = '[AdminQuarantine] Load more';
}

/**
 * Approve (back to the pipeline) or discard (kept for audit, hidden from
 * every list) one or more quarantined leads. One id = the row action;
 * several = the bulk bar. Each lead is its own backend call.
 */
export class DecideQuarantined {
  static readonly type = '[AdminQuarantine] Decide';
  constructor(
    readonly ids: readonly string[],
    readonly decision: QuarantineDecision,
  ) {}
}

/** Dismiss the inline partial/total failure message. */
export class DismissQuarantineError {
  static readonly type = '[AdminQuarantine] Dismiss error';
}
