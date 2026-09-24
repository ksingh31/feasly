/**
 * Thin estimate route (M1 skeleton). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - Public by design for the M1 walking skeleton: no auth yet. BE-4 wraps
 *   this route's handler with authentication at the pipeline/adapter layer —
 *   the route itself stays auth-agnostic so the wrap point is one line.
 * - Runs inside the BE0-003 request pipeline (correlation + rate limiting +
 *   RFC 7807 errors) via composition; the Azure Functions trigger adapter
 *   that binds POST /api/v1/estimate lands in BE-3.
 * - The response is the engine's EstimateResult, which always carries the
 *   pinned costDataVersion. Mapping to the gated contracts EstimateResponse
 *   (estimateId, addressKey, blur rules) lands with the lead-gate stories.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { EstimateResult } from '@feasly/cost-engine';
import type { EstimateService } from '../services/estimate.service';

export interface EstimateRouteDeps {
  readonly estimate: EstimateService;
}

export interface EstimateRoute {
  /** Runs one estimate on an untrusted request body. */
  handle(requestBody: unknown): Promise<EstimateResult>;
}

export function createEstimateRoute(deps: EstimateRouteDeps): EstimateRoute {
  return {
    handle: (requestBody: unknown): Promise<EstimateResult> =>
      deps.estimate.estimate(requestBody),
  };
}
