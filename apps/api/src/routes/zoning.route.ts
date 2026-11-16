/**
 * Thin zoning catalogue route (#687).
 *
 * - GET /api/v1/zoning/districts — public. Returns the active catalogue for
 *   the configured city: `{ city, effectiveDate, bylaw, bylawVersion,
 *   sourceUrl, districts }`, verified values only.
 * - #757: each response carries `freshness` — `rulesAsOf` (the catalogue's
 *   effectiveDate) and `stale` while the City changed rules after it, so
 *   the panel can say "rules recently changed — confirm with the City".
 * - No catalogue for the configured city (a config error) → 503
 *   DEPENDENCY_UNAVAILABLE, not retryable.
 *
 * Hard rules (enforced by test/boundaries.test.ts): no db/, no process.env,
 * depends on the service interface only.
 */
import type { ZoningDistrictsResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { ZoningService } from '../services/zoning.service';
import type { ZoningWatchService } from '../services/zoning-watch.service';

export interface ZoningRouteDeps {
  readonly zoning: ZoningService;
  /** #757: catalogue freshness; omitted → no `freshness` field. */
  readonly watch?: Pick<ZoningWatchService, 'getFreshness'>;
}

export interface ZoningRoute {
  /** The active district catalogue (verified values only). */
  handle(): Promise<ZoningDistrictsResponse>;
}

export function createZoningRoute(deps: ZoningRouteDeps): ZoningRoute {
  return {
    handle: async (): Promise<ZoningDistrictsResponse> => {
      const catalogue = deps.zoning.getCatalogue();
      if (!catalogue) {
        throw new HttpError(
          503,
          ErrorCodes.DEPENDENCY_UNAVAILABLE,
          'Zoning information is not available right now.',
          false,
        );
      }
      if (!deps.watch) return catalogue;
      return { ...catalogue, freshness: await deps.watch.getFreshness(catalogue) };
    },
  };
}
