/** Which way a dispute was resolved. */
export type AdminDisputeOutcome = 'accepted' | 'rejected';

/** Reload the open-disputes list (oldest first) from the backend. */
export class LoadAdminDisputes {
  static readonly type = '[AdminDisputes] Load';
}

/** Open the detail panel for a dispute (evidence snapshot + audit trail). */
export class SelectAdminDispute {
  static readonly type = '[AdminDisputes] Select dispute';
  constructor(readonly id: string) {}
}

/** Close the dispute detail panel. */
export class ClearSelectedAdminDispute {
  static readonly type = '[AdminDisputes] Clear selected dispute';
}

/**
 * Accept a dispute: voids the invoice (Stripe refund first when it was
 * already paid — the credit note). Audit-logged server-side.
 */
export class AcceptAdminDispute {
  static readonly type = '[AdminDisputes] Accept dispute';
  constructor(
    readonly id: string,
    readonly note?: string,
  ) {}
}

/**
 * Reject a dispute: the invoice returns to in_review with a fresh 7-day
 * window. Audit-logged server-side.
 */
export class RejectAdminDispute {
  static readonly type = '[AdminDisputes] Reject dispute';
  constructor(
    readonly id: string,
    readonly note?: string,
  ) {}
}

/** Dismiss the resolution confirmation banner. */
export class DismissAdminDisputeResolution {
  static readonly type = '[AdminDisputes] Dismiss resolution';
}
