/**
 * Thin city-data freshness route (trust-strip/01).
 * Routes are adapters, not logic: call exactly one service method → return
 * the result.
 *
 * - GET /api/v1/city-data/freshness — public. The service NEVER throws, so
 *   this route answers 200 in every case: `{ "refreshedMonth": "September
 *   2026" }` when the Socrata metadata is readable, `{ "refreshedMonth":
 *   null }` when it isn't (the frontend falls back to "Live City data").
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { CityDataFreshnessResponse } from '@feasly/contracts';
import type { CityDataFreshnessService } from '../services/city-data-freshness.service';

export interface CityDataFreshnessRouteDeps {
  readonly freshness: CityDataFreshnessService;
}

export interface CityDataFreshnessRoute {
  /** Dataset freshness; 200 always — null when Socrata is unreachable. */
  handle(): Promise<CityDataFreshnessResponse>;
}

export function createCityDataFreshnessRoute(
  deps: CityDataFreshnessRouteDeps,
): CityDataFreshnessRoute {
  return {
    handle: async (): Promise<CityDataFreshnessResponse> => {
      const { refreshedMonth } = await deps.freshness.getFreshness();
      return { refreshedMonth };
    },
  };
}
