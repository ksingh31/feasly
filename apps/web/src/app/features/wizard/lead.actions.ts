/** Lead-gate actions (FE-004). The lead state is in-memory only — PII is never persisted. */

/** The lead POST succeeded: keep the non-sensitive receipt for the report page. */
export class StoreLeadResult {
  static readonly type = '[Lead] Store result';
  constructor(
    public readonly result: {
      leadId: string;
      email: string;
      magicLinkSent: boolean;
      expiresInDays: number;
    },
  ) {}
}

/** NGXS action: drop the lead receipt (used by "Estimate another address"). */
export class ClearLead {
  static readonly type = '[Lead] Clear';
}
