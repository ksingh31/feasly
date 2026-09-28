/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices.
 *
 * Admin-only: manually create a commission invoice for a builder's
 * converted lead. Mirrors the builder-reported contract shape
 * (`POST /api/v1/billing/report-contract`) plus tenantKey — the admin
 * picks the builder. Runs the same charge path via
 * BillingService.reportContract (attribution → draft invoice →
 * auto-submitted into the 7-day review window).
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-create-invoice/index.js` (self-contained — the Function
 * App has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingCreateInvoiceHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.createInvoice(req.headers ?? {}, req.body),
    { path: '/api/v1/admin/billing/invoices' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingCreateInvoiceHandler;
