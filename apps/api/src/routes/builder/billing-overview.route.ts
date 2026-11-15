/**
 * Thin builder billing-overview route (portal redesign — Money page, #531).
 *
 * - `GET /api/v1/builder/billing/overview` — one call powers the Money page
 *   header: outstanding total, next card auto-charge, failed invoices, plan
 *   type + configured commission rate, card on file. Builder-gated
 *   (`builder:billing`, enforced by the registry before the route runs);
 *   tenant-scoped to the session's builder org — the tenant key comes from
 *   the session, never from the request.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { BuilderBillingOverviewResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { BuilderGuard } from '../../middleware/builder-guard';
import type { BillingOverviewService } from '../../services/billing/billing-overview.service';

export interface BuilderBillingOverviewRouteDeps {
  readonly overview: BillingOverviewService;
  readonly builderGuard: Pick<BuilderGuard, 'getBuilderSession'>;
}

export interface BuilderBillingOverviewRoute {
  /** GET /api/v1/builder/billing/overview */
  getOverview(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderBillingOverviewResponse>;
}

export function createBuilderBillingOverviewRoute(
  deps: BuilderBillingOverviewRouteDeps,
): BuilderBillingOverviewRoute {
  const { overview, builderGuard } = deps;

  return {
    async getOverview(headers): Promise<BuilderBillingOverviewResponse> {
      const session = await builderGuard.getBuilderSession(headers);
      if (!session) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Builder authentication required.',
          false,
        );
      }
      return overview.getOverview(session.tenantKey);
    },
  };
}
