/**
 * Thin real-user-monitoring ingest route (#830). Validate → one service
 * call → result. Public by design (browser beacons are unauthenticated);
 * abuse resistance comes from the dedicated 10/min per-IP limiter
 * (`webTelemetryPipeline`, composition.ts) plus the service's per-instance
 * trace budget. The body is never logged.
 *
 * Adapter: `src/functions/telemetry.ts` → POST /api/v1/telemetry.
 */
import type { WebTelemetryAccepted } from '@feasly/contracts';
import type { WebTelemetryService } from '../services/web-telemetry.service';

export interface WebTelemetryRouteDeps {
  readonly webTelemetry: WebTelemetryService;
}

export interface WebTelemetryRoute {
  handle(requestBody: unknown): Promise<WebTelemetryAccepted>;
}

export function createWebTelemetryRoute(deps: WebTelemetryRouteDeps): WebTelemetryRoute {
  return {
    handle: (requestBody: unknown): Promise<WebTelemetryAccepted> =>
      deps.webTelemetry.ingest(requestBody),
  };
}
