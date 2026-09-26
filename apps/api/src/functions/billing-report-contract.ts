/**
 * Azure Functions v3 trigger adapter — POST /api/v1/billing/report-contract.
 *
 * Builder reports the signed construction contract (excl. land) for one of
 * their leads. Runs the commission charge path: attribution → draft invoice
 * → auto-submitted into the 7-day review window.
 */
import {
  dispatchBilling,
  type FunctionContext,
  type FunctionRequest,
} from './billing/shared';

export async function billingReportContractHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBilling(context, req, (app) =>
    app.billingRoute.reportContract(req.headers ?? {}, req.body),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = billingReportContractHandler;
