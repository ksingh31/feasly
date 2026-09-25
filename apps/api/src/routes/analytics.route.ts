/**
 * Thin analytics-ingest route (story consumer/01). Routes are adapters, not
 * logic: validate input → call exactly one service method → return the
 * result.
 *
 * - Public by design: callers are unauthenticated by definition (this is
 *   first-party analytics). Abuse resistance comes from the dedicated
 *   300/min per-IP rate limiter on the analytics pipeline (see
 *   composition.ts), not from auth.
 * - Runs inside the BE0-003 request pipeline (correlation + rate limiting +
 *   RFC 7807 errors) via the Azure Functions trigger adapter
 *   (`src/functions/events.ts` → POST /api/v1/events).
 * - The body is never logged: the pipeline logger only ever sees service
 *   error messages, which reference field paths, never values.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { AnalyticsEvent } from '@feasly/contracts';
import type { AnalyticsService } from '../services/analytics.service';

export interface AnalyticsRouteDeps {
  readonly analytics: AnalyticsService;
}

export interface AnalyticsRoute {
  /** Validates consent + shape and appends one analytics event. */
  handle(requestBody: unknown): Promise<AnalyticsEvent>;
}

export function createAnalyticsRoute(deps: AnalyticsRouteDeps): AnalyticsRoute {
  return {
    handle: (requestBody: unknown): Promise<AnalyticsEvent> =>
      deps.analytics.ingestEvent(requestBody),
  };
}
