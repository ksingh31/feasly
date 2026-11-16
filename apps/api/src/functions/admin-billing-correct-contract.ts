/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/correct-contract.
 *
 * Admin-only (#715): correct the reported contract on an uncharged
 * invoice; commission and tax are recalculated and the review window
 * restarts.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-correct-contract/index.js` (self-contained — the Function App
 * has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingCorrectContractHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.correctContract(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/billing/invoices/{id}/correct-contract' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingCorrectContractHandler;
