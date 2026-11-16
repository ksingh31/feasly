/**
 * Callback-request contracts. The team inbox address lives server-side;
 * the client never sees it (grep-tested in the UI epic).
 */

export type CallbackWindow = 'morning' | 'afternoon' | 'evening';

export interface CallbackRequest {
  readonly reportToken: string;
  readonly name: string;
  /** Required at the callback step (optional at the lead gate). */
  readonly phone: string;
  readonly window: CallbackWindow;
  /**
   * #836: preferred call day, `YYYY-MM-DD` on the America/Edmonton
   * calendar. Must be a business day (Mon–Fri) from tomorrow through the
   * configured window (default 14 days). Optional at the API so older
   * clients keep working; the report form always sends it.
   */
  readonly preferredDate?: string;
  /** #836: optional free-text notes for the caller (max 500 chars). */
  readonly notes?: string;
}

export interface CallbackResponse {
  readonly ok: true;
  readonly window: CallbackWindow;
  /** #836: echoed preferred day (null when the request carried none). */
  readonly preferredDate?: string | null;
}

/**
 * #836: a stored callback request as shown to the builder (portal lead)
 * and in the admin lead detail. Contact details live on the lead itself.
 */
export interface LeadCallbackSummary {
  readonly id: string;
  readonly window: CallbackWindow;
  /** `YYYY-MM-DD` (Edmonton calendar); null for pre-#836 requests. */
  readonly preferredDate: string | null;
  readonly notes: string | null;
  readonly phone: string;
  /** 'pending' | 'done'. */
  readonly status: string;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
}
