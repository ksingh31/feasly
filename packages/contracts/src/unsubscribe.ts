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
  /** Already opted out: the page shows "already unsubscribed", POST is a no-op. */
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
}
