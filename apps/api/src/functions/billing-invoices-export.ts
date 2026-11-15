/**
 * Azure Functions v3 trigger adapter — GET /api/v1/billing/invoices/export.csv.
 *
 * Builder's own invoice CSV for a period (#728). Tenant from the session. Audit-logged.
 * Registry permissions are enforced in the shared dispatcher.
 *
 * Bundled by `npm run bundle:functions` into `billing-invoices-export/index.js`.
 */
import {
  dispatchAuditFinance,
  type FunctionContext,
  type FunctionRequest,
} from './audit-finance/shared';

export async function billingInvoicesExportHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAuditFinance(
    context,
    req,
    (app, headers) => app.auditFinanceRoute.builderExportInvoices(headers, req.query ?? {}),
    { path: '/api/v1/billing/invoices/export.csv', csv: true },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingInvoicesExportHandler;
