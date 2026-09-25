/**
 * Azure Functions v3 trigger adapter —
 * POST /api/v1/estimates/{estimateId}/narrative.
 * Bundled by `npm run bundle:functions` into `narrative/index.js`.
 */
import {
  dispatchNarrative,
  type FunctionContext,
  type FunctionRequest,
} from './narrative/shared';

export async function narrativeHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const estimateId = context.bindingData?.['estimateId'];
  await dispatchNarrative(context, req, (app) =>
    app.narrativeRoute.generateNarrative(
      req.headers ?? {},
      typeof estimateId === 'string' ? estimateId : '',
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = narrativeHandler;
