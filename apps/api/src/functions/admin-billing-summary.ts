/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/billing/summary.
 *
 * Finance summary for a period (#728): invoiced, collected, refunded, outstanding, tax, by builder.
 * Registry permissions are enforced in the shared dispatcher.
 *
 * Bundled by `npm run bundle:functions` into `admin-billing-summary/index.js`.
 */
import {
  dispatchAuditFinance,
  type FunctionContext,
  type FunctionRequest,
} from './audit-finance/shared';

export async function adminBillingSummaryHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAuditFinance(
    context,
    req,
    (app, headers) => app.auditFinanceRoute.financeSummary(headers, req.query ?? {}),
    { path: '/api/v1/admin/billing/summary' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingSummaryHandler;
