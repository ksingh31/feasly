/**
 * Real-user browser monitoring (#830): Core Web Vitals + uncaught JS errors,
 * batched by the web app and sent with `navigator.sendBeacon` to
 * `POST /api/v1/telemetry`. The API writes each item to App Insights as one
 * structured JSON trace.
 *
 * PII discipline: the shape is closed. `page` is the Angular route PATTERN
 * (e.g. `/report/:token`), never the concrete URL — no ids, tokens or query
 * strings. Error `source` is a script path (origin + query stripped). No
 * session id, user id, IP or user agent is sent.
 */

/** Core Web Vitals captured with the `web-vitals` library. */
export type WebVitalName = 'LCP' | 'INP' | 'CLS' | 'TTFB';

/** `web-vitals` rating bucket. */
export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

export interface WebVitalItem {
  readonly type: 'vital';
  readonly name: WebVitalName;
  /** Milliseconds (LCP/INP/TTFB) or unitless score (CLS). */
  readonly value: number;
  readonly rating: WebVitalRating;
  /** Route pattern, e.g. `/estimate/scope`. */
  readonly page: string;
}

export interface WebErrorItem {
  readonly type: 'error';
  /** `error` (window.onerror / ErrorHandler) or `unhandledrejection`. */
  readonly kind: 'error' | 'unhandledrejection';
  /** Error message, truncated client-side. */
  readonly message: string;
  /** Script path without origin or query, when known. */
  readonly source?: string;
  readonly line?: number;
  readonly column?: number;
  /** Route pattern, e.g. `/estimate/scope`. */
  readonly page: string;
}

export type WebTelemetryItem = WebVitalItem | WebErrorItem;

/** Body of `POST /api/v1/telemetry` (sent as `text/plain` JSON by sendBeacon). */
export interface WebTelemetryBatch {
  readonly items: readonly WebTelemetryItem[];
}

/** Response of `POST /api/v1/telemetry` (202). */
export interface WebTelemetryAccepted {
  readonly accepted: number;
}
