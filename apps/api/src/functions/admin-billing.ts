/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/billing.
 *
 * Billing-health dashboard payload (billing/03 follow-on, was OPS-007):
 * MRR, in-review invoice aging buckets, dunning states with
 * `past_due_since`, and the webhook health panel. Read-only by design —
 * no charge/refund/void actions exist on this endpoint.
 * Admin-gated via the session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-billing/index.js`
 * (self-contained — the Function App has no node_modules).
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(context, req, (app) =>
    app.adminBillingRoute.getHealth(req.headers ?? {}),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingHandler;
