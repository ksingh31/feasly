/**
 * Thin admin billing-health route (billing/03 follow-on — /admin/billing,
 * was OPS-007). Routes are adapters, not logic: validate input → require
 * auth → call exactly one service method → return the result.
 *
 * - `GET /api/v1/admin/billing` — billing-health dashboard payload
 *   (MRR, in-review aging buckets, dunning with `past_due_since`, webhook
 *   health). Admin-gated.
 * - `POST /api/v1/admin/billing/invoices/{id}/retry` — retry a failed
 *   commission charge (BILL-03). Admin-gated, `billing:manage`. This is the
 *   single mutating action on this route; the health payload stays read-only.
 *
 * Read-only by design except the retry action: no refund/void endpoints
 * exist on this route.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type { BillingHealthResponse } from '@feasly/contracts';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BillingHealthService } from '../services/billing/billing-health.service';
import type { CommissionService } from '../services/billing/commission.service';

const invoiceIdSchema = z.string().trim().uuid();

export interface AdminBillingRouteDeps {
  readonly billingHealth: BillingHealthService;
  readonly commission: CommissionService;
  readonly adminGuard: AdminGuard;
}

export interface AdminBillingRoute {
  /** GET /api/v1/admin/billing */
  getHealth(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BillingHealthResponse>;
  /** POST /api/v1/admin/billing/invoices/{id}/retry */
  retryCharge(
    headers: Record<string, string | string[] | undefined>,
    invoiceId: unknown,
  ): Promise<{ invoiceId: string; status: string; retryCount: number }>;
}

export function createAdminBillingRoute(
  deps: AdminBillingRouteDeps,
): AdminBillingRoute {
  const { billingHealth, commission, adminGuard } = deps;

  return {
    async getHealth(headers): Promise<BillingHealthResponse> {
      await adminGuard.requireAdmin(headers);
      return billingHealth.getHealth();
    },

    async retryCharge(headers, invoiceId) {
      await adminGuard.requireAdmin(headers);
      const invoice = await commission.retryCharge(
        invoiceIdSchema.parse(invoiceId),
      );
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        retryCount: invoice.retryCount,
      };
    },
  };
}
