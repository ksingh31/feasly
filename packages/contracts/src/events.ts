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
  | 'pdf_download';

export interface AnalyticsEvent {
  readonly event: AnalyticsEventName;
  readonly route: string;
  /** ISO timestamp of the client-side occurrence. */
  readonly ts: string;
}
