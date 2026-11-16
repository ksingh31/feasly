/**
 * Analytics contracts. First-party only, no cookies. The payload is a closed
 * shape — email, address, and figures cannot be added without a contract change,
 * which is exactly the point.
 */

export type AnalyticsEventName =
  | 'step_view'
  | 'gate_view'
  // #835: a valid gate form was submitted (before the API answers);
  // `gate_convert` fires on success. view → submit → convert.
  | 'gate_submit'
  | 'gate_convert'
  | 'report_open'
  | 'tier_toggle'
  | 'callback_request'
  | 'partner_share'
  | 'pdf_download'
  | 'embed_loaded'
  // #704: returning-user recovery + link sharing.
  | 'report_resume'
  | 'report_link_request'
  | 'report_link_copy'
  | 'report_link_share'
  // #755: which project path the scope step offered first (by home age),
  // and whether a younger home's user overrode it to a new build.
  | 'steer_new_build_offered'
  | 'steer_renovation_offered'
  | 'steer_none_offered'
  | 'steer_override_new_build'
  // #814: top-of-funnel visibility before paid traffic. `preview_view`
  // replaces the `step_view` on /estimate/preview (the funnel still counts
  // legacy preview `step_view` rows, so clients must send one or the other).
  | 'landing_view'
  | 'address_search'
  | 'address_selected'
  | 'address_no_results'
  | 'out_of_coverage'
  | 'property_unsupported'
  | 'preview_view'
  | 'estimate_error'
  | 'magic_link_open'
  // #814 / #683: assessed-value page.
  | 'assessment_view'
  | 'assessment_to_estimate';

/**
 * Which ad click-id parameter was present on the landing URL (#814). Only
 * the parameter's *name* is recorded — the click id value itself never
 * leaves the browser on an event. Closed set; unknown ids are omitted.
 */
export type ClickIdType = 'gclid' | 'gbraid' | 'wbraid' | 'msclkid' | 'fbclid';

/** Max length of each `AnalyticsSource` string field (API rejects longer). */
export const ANALYTICS_SOURCE_FIELD_MAX_LENGTH = 100;

/**
 * Campaign attribution captured from the landing URL (#814). Closed shape,
 * every field optional and capped at {@link ANALYTICS_SOURCE_FIELD_MAX_LENGTH}
 * characters. Values must not carry PII: the API rejects values containing
 * `@` (email) or `$` (dollar figure) and anything outside a plain-text
 * charset (letters, digits, space and `_ - . + ~ | : / ( )`).
 */
export interface AnalyticsSource {
  readonly utm_source?: string;
  readonly utm_medium?: string;
  readonly utm_campaign?: string;
  readonly utm_term?: string;
  readonly utm_content?: string;
  readonly click_id_type?: ClickIdType;
}

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
  /**
   * admin/07: tenant key for embed-attributed events. Omitted = Feasly-direct
   * traffic. Embed clients set this so the funnel dashboard can filter
   * per-tenant funnels. Optional and additive — old clients keep working.
   */
  readonly tenant_key?: string;
  /**
   * #814: campaign attribution for the session. Optional and additive; the
   * funnel dashboard filters and groups on `utm_source` / `utm_campaign`.
   */
  readonly source?: AnalyticsSource;
}
