/**
 * Azure Functions v3 trigger adapter — POST /api/v1/builder/agreement/accept.
 *
 * Builder org admin accepts the current platform agreement (#722). Members get 403 AGREEMENT_ADMIN_REQUIRED.
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderAgreementAcceptHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderAgreementRoute.accept(req.headers ?? {}, req.body ?? {}),
    { path: '/api/v1/builder/agreement/accept' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderAgreementAcceptHandler;
