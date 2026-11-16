/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/admin/billing/simulated/invoices/{id}/events (#753).
 *
 * Admin dev panel: fire a dispute, dashboard refund or delayed failure
 * against an invoice's simulated PaymentIntent. The resulting Stripe-shaped
 * event goes through the production webhook handler. 404 when
 * PAYMENTS_PROVIDER=stripe.
 */
import {
  dispatchAdminBilling,
  type FunctionContext,
  type FunctionRequest,
} from './admin-billing/shared';

export async function adminBillingSimulatedEventHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminBilling(context, req, (app) =>
    app.simulatedPaymentsRoute.fireInvoiceEvent(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
    { path: '/api/v1/admin/billing/simulated/invoices/{id}/events' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminBillingSimulatedEventHandler;
