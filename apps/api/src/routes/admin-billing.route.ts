/**
 * Thin admin billing-health route (billing/03 follow-on — /admin/billing,
 * was OPS-007). Routes are adapters, not logic: validate input → require
 * auth → call exactly one service method → return the result.
 *
 * - `GET /api/v1/admin/billing` — billing-health dashboard payload
 *   (MRR, in-review aging buckets, dunning with `past_due_since`, webhook
 *   health). Admin-gated.
 *
 * Read-only by design: no charge/refund/void endpoints exist on this route.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { BillingHealthResponse } from '@feasly/contracts';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BillingHealthService } from '../services/billing/billing-health.service';

export interface AdminBillingRouteDeps {
  readonly billingHealth: BillingHealthService;
  readonly adminGuard: AdminGuard;
}

export interface AdminBillingRoute {
  /** GET /api/v1/admin/billing */
  getHealth(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BillingHealthResponse>;
}

export function createAdminBillingRoute(
  deps: AdminBillingRouteDeps,
): AdminBillingRoute {
  const { billingHealth, adminGuard } = deps;

  return {
    async getHealth(headers): Promise<BillingHealthResponse> {
      await adminGuard.requireAdmin(headers);
      return billingHealth.getHealth();
    },
  };
}
