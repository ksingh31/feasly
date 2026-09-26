/**
 * Thin preview route (phase-2 wiring). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * Public endpoint (pre-gate by definition) — the Function adapter applies
 * the public rate limiter. The return type is the contracts
 * `PreviewEstimateResponse`: blurred figures + empty rows, so leaking a
 * real figure here is a compile error.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { PreviewEstimateResponse } from '@feasly/contracts';
import type { PreviewService } from '../services/preview.service';

export interface PreviewRouteDeps {
  readonly preview: PreviewService;
}

export interface PreviewRoute {
  /** Runs a pre-gate preview on an untrusted request body. */
  handle(requestBody: unknown): Promise<PreviewEstimateResponse>;
}

export function createPreviewRoute(deps: PreviewRouteDeps): PreviewRoute {
  return {
    handle: (requestBody: unknown): Promise<PreviewEstimateResponse> =>
      deps.preview.preview(requestBody),
  };
}
