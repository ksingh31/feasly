/**
 * Thin estimate route (BE-3). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - Public by design for the M1 walking skeleton: no auth yet. BE-4 wraps
 *   this route's handler with authentication at the pipeline/adapter layer —
 *   the route itself stays auth-agnostic so the wrap point is one line.
 * - Runs inside the BE0-003 request pipeline (correlation + rate limiting +
 *   RFC 7807 errors) via the Azure Functions trigger adapter
 *   (`src/functions/estimate.ts` → POST /api/v1/estimate).
 * - The response is the contracts `EstimateResponse` (estimateId, addressKey,
 *   real ranges, pinned costDataVersion). Pre-gate blur is a separate
 *   endpoint's type (BE3-002) — this route's return type makes leaking a
 *   blurred figure a compile error in the other direction.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { ComparisonEstimateResponse, EstimateResponse } from '@feasly/contracts';
import type { EstimateService } from '../services/estimate.service';

export interface EstimateRouteDeps {
  readonly estimate: EstimateService;
}

export interface EstimateRoute {
  /** Runs one estimate on an untrusted request body. */
  handle(requestBody: unknown): Promise<EstimateResponse | ComparisonEstimateResponse>;
}

export function createEstimateRoute(deps: EstimateRouteDeps): EstimateRoute {
  return {
    handle: (requestBody: unknown): Promise<EstimateResponse | ComparisonEstimateResponse> =>
      deps.estimate.estimate(requestBody),
  };
}
