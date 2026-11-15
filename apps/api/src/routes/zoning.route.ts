/**
 * Thin zoning catalogue route (#687).
 *
 * - GET /api/v1/zoning/districts — public. Returns the active catalogue for
 *   the configured city: `{ city, effectiveDate, bylaw, bylawVersion,
 *   sourceUrl, districts }`, verified values only.
 * - No catalogue for the configured city (a config error) → 503
 *   DEPENDENCY_UNAVAILABLE, not retryable.
 *
 * Hard rules (enforced by test/boundaries.test.ts): no db/, no process.env,
 * depends on the service interface only.
 */
import type { ZoningDistrictsResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { ZoningService } from '../services/zoning.service';

export interface ZoningRouteDeps {
  readonly zoning: ZoningService;
}

export interface ZoningRoute {
  /** The active district catalogue (verified values only). */
  handle(): Promise<ZoningDistrictsResponse>;
}

export function createZoningRoute(deps: ZoningRouteDeps): ZoningRoute {
  return {
    handle: (): Promise<ZoningDistrictsResponse> => {
      const catalogue = deps.zoning.getCatalogue();
      if (!catalogue) {
        return Promise.reject(
          new HttpError(
            503,
            ErrorCodes.DEPENDENCY_UNAVAILABLE,
            'Zoning information is not available right now.',
            false,
          ),
        );
      }
      return Promise.resolve(catalogue);
    },
  };
}
