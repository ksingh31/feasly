/**
 * Analytics contracts. First-party only, no cookies. The payload is a closed
 * shape — email, address, and figures cannot be added without a contract change,
 * which is exactly the point.
 */

export type AnalyticsEventName =
  | 'step_view'
  | 'gate_view'
  | 'gate_convert'
  | 'report_open'
  | 'tier_toggle'
  | 'callback_request'
  | 'partner_share'
  | 'pdf_download'
  | 'embed_loaded';

export interface AnalyticsEvent {
  readonly event: AnalyticsEventName;
  readonly route: string;
  /** ISO timestamp of the client-side occurrence. */
  readonly ts: string;
  /**
   * ISO timestamp of the consent-banner acknowledgement that authorized
   * this event (story consumer/01). The ingest endpoint rejects payloads
   * with a missing or future-dated consent_ts — consent is proven per
   * event, not per session.
   */
  readonly consent_ts: string;
}
