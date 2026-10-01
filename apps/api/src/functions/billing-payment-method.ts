/**
 * Azure Functions v3 trigger adapter — GET + PUT /api/v1/billing/payment-method.
 *
 * Builder reads (GET) or sets (PUT) their org's default payment method
 * (billing/12): 'card' (card on file), 'cheque', 'e_transfer', or
 * 'bank_draft'. The default is snapshotted onto every new commission
 * invoice at creation; existing invoices keep their method. Builder-gated;
 * tenant-scoped.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingPaymentMethodHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'PUT') {
    await dispatchBilling(
      context,
      req,
      (app) =>
        app.billingRoute.setDefaultPaymentMethod(req.headers ?? {}, req.body),
      { path: '/api/v1/billing/payment-method' },
    );
    return;
  }
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.getDefaultPaymentMethod(req.headers ?? {}),
    { path: '/api/v1/billing/payment-method' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingPaymentMethodHandler;
