/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/agreement.
 *
 * Platform agreement status + text for the session's builder org (#722).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAgreementHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderAgreementRoute.getAgreement(req.headers ?? {}),
    { path: '/api/v1/builder/agreement' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAgreementHandler;
