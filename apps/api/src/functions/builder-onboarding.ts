/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/onboarding.
 *
 * First-run onboarding checklist for the session's builder org (#722).
 */
import {
  dispatchBuilderAuth,
  type FunctionContext,
  type FunctionRequest,
} from './builder-auth/shared';

export async function builderOnboardingHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchBuilderAuth(
    context,
    req,
    (app) => app.builderAgreementRoute.getOnboarding(req.headers ?? {}),
    { path: '/api/v1/builder/onboarding' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderOnboardingHandler;
