/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/invoices/{id}/dunning (#718).
 *
 * Admin-only: edit one commission invoice's retry schedule — pause,
 * resume or cancel automatic retries and reminders, or set the invoice's
 * grace period in days. Audited with the admin identity.
 *
 * Bundled by `npm run bundle:functions` into `admin-billing-dunning/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingDunningHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(context, req, (app) =>
    app.adminBillingRoute.updateDunning(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
    { path: '/api/v1/admin/billing/invoices/{id}/dunning' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingDunningHandler;
