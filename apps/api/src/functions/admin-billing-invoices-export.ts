/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/billing/invoices/export.csv.
 *
 * Invoice CSV for a period, every builder or one (#728). Audit-logged.
 * Registry permissions are enforced in the shared dispatcher.
 *
 * Bundled by `npm run bundle:functions` into `admin-billing-invoices-export/index.js`.
 */
import {
  dispatchAuditFinance,
  type FunctionContext,
  type FunctionRequest,
} from './audit-finance/shared';

export async function adminBillingInvoicesExportHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAuditFinance(
    context,
    req,
    (app, headers) => app.auditFinanceRoute.adminExportInvoices(headers, req.query ?? {}),
    { path: '/api/v1/admin/billing/invoices/export.csv', csv: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingInvoicesExportHandler;
