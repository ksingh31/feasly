/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/void.
 *
 * Admin-only (#715): void a draft / in_review / failed commission invoice
 * so it is never charged.
 *
 * Bundled by `npm run bundle:functions` into
 * `admin-billing-void/index.js` (self-contained — the Function App
 * has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingVoidHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(
    context,
    req,
    (app) =>
      app.adminBillingRoute.voidInvoice(
        req.headers ?? {},
        context.bindingData?.['id'],
        req.body,
      ),
    { path: '/api/v1/admin/billing/invoices/{id}/void' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingVoidHandler;
