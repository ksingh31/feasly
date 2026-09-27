/**
 * Unsubscribe-center contracts (email/03).
 *
 * The token never leaves the URL path; the client holds only the opaque
 * token and the state the endpoints describe. `GET` is read-only (the
 * frontend renders the confirmation page from it); `POST` performs the
 * opt-out and is idempotent.
 */

export interface UnsubscribeStateValid {
  readonly valid: true;
  /** The lead this token unsubscribes. Never the email — no PII in the URL flow. */
  readonly leadId: string;
  /** Email opt-out (CASL). True when the lead unsubscribed from estimate emails. */
  readonly emailOptedOut: boolean;
  /**
   * Calls/messages opt-out — Feasly and builders associated with us may no
   * longer contact the lead about their estimate.
   */
  readonly contactOptedOut: boolean;
  /** ISO timestamp of the last consent change (any flag). */
  readonly consentUpdatedAt: string;
  /**
   * Legacy alias for emailOptedOut (email/03 one-click flow consumers).
   * Kept so existing clients keep working.
   */
  readonly alreadyUnsubscribed: boolean;
}

export interface UnsubscribeStateInvalid {
  readonly valid: false;
  readonly reason: 'invalid' | 'expired';
}

export type UnsubscribeStateResponse =
  | UnsubscribeStateValid
  | UnsubscribeStateInvalid;

export interface UnsubscribeResultResponse {
  readonly unsubscribed: boolean;
  /** True when the lead had already opted out before this call. */
  readonly alreadyUnsubscribed: boolean;
  /** Post-save state of the email opt-out flag. */
  readonly emailOptedOut: boolean;
  /** Post-save state of the calls/messages opt-out flag. */
  readonly contactOptedOut: boolean;
}

/**
 * Granular consent preferences saved from the unsubscribe preference page.
 * True = opt OUT of that channel. Both false = fully opted in.
 */
export interface UnsubscribePreferencesInput {
  readonly emailOptOut: boolean;
  readonly contactOptOut: boolean;
}
