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
 * - `POST /api/v1/admin/billing/invoices` — manually create a commission
 *   invoice for a builder's converted lead (manual invoicing). Mirrors the
 *   builder-reported contract shape
 *   (`POST /api/v1/billing/report-contract`): leadId (required),
 *   contractValueCents (integer cents, EXCLUDING land), contractSignedAt
 *   (ISO with offset) — plus tenantKey, since the admin picks the builder.
 *   Runs the SAME charge path via `BillingService.reportContract`
 *   (attribution → draft invoice → auto-submitted into the 7-day review
 *   window). Admin-gated, `billing:manage`.
 *
 * Read-only by design except the retry and manual-invoice actions: no
 * refund/void endpoints exist on this route.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  BillingHealthResponse,
  ManualInvoiceRequest,
  ManualInvoiceResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BillingHealthService } from '../services/billing/billing-health.service';
import type { BillingService } from '../services/billing/billing.service';
import type { CommissionService } from '../services/billing/commission.service';

const invoiceIdSchema = z.string().trim().uuid();

const manualInvoiceBodySchema: z.ZodType<ManualInvoiceRequest> = z.object({
  tenantKey: z.string().trim().min(1).max(120),
  leadId: z.string().trim().uuid(),
  /** Signed construction contract value in integer cents, EXCLUDING land. */
  contractValueCents: z.number().int().positive(),
  contractSignedAt: z.string().datetime({ offset: true }),
});

export interface AdminBillingRouteDeps {
  readonly billingHealth: BillingHealthService;
  readonly commission: CommissionService;
  readonly billing: BillingService;
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
  /** POST /api/v1/admin/billing/invoices */
  createInvoice(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<ManualInvoiceResponse>;
}

export function createAdminBillingRoute(
  deps: AdminBillingRouteDeps,
): AdminBillingRoute {
  const { billingHealth, commission, billing, adminGuard } = deps;

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

    async createInvoice(headers, body): Promise<ManualInvoiceResponse> {
      await adminGuard.requireAdmin(headers);
      const parsed = manualInvoiceBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid invoice body: tenantKey, leadId (UUID), a positive ' +
            'contractValueCents, and contractSignedAt (ISO datetime with ' +
            'timezone offset) are required.',
          false,
        );
      }
      // Same charge path as the builder-reported flow — attribution (12-month
      // window), draft invoice, auto-submitted into the 7-day review window.
      const result = await billing.reportContract({
        tenantKey: parsed.data.tenantKey,
        leadId: parsed.data.leadId,
        contractValueCents: parsed.data.contractValueCents,
        contractSignedAt: new Date(parsed.data.contractSignedAt),
      });
      if (!result.billed) {
        // e.g. the flat billing model: per-event commission is not the
        // charge path. 422 — the request is valid, the model refuses it.
        throw new HttpError(
          422,
          ErrorCodes.BILLING_MODEL_MISMATCH,
          `Invoice not created: ${result.reason}.`,
          false,
        );
      }
      const invoice = await commission.getById(result.invoiceId);
      return {
        invoiceId: invoice.id,
        status: invoice.status,
        tenantKey: invoice.tenantKey,
        leadId: invoice.leadId,
        contractValueCents: invoice.contractValueCents,
        commissionCents: invoice.commissionCents,
        currency: invoice.currency,
        reviewDueAt: invoice.reviewDueAt?.toISOString() ?? null,
      };
    },
  };
}
