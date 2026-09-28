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
      /** Why the magic-link email failed — present only when magicLinkSent is false. */
      emailError?: 'invalid-recipient' | 'delivery-failed';
      /**
       * Idempotent resubmit (P0 2026-09-27): no new email was sent because
       * one already went out recently for this email + property.
       */
      emailAlreadySent?: boolean;
    },
  ) {}
}

/** NGXS action: drop the lead receipt (used by "Estimate another address"). */
export class ClearLead {
  static readonly type = '[Lead] Clear';
}
