/**
 * Azure Functions v3 trigger adapter — lead comment thread (builder).
 *
 * GET /api/v1/builder/leads/{leadId}/comments — org-visible thread.
 * POST /api/v1/builder/leads/{leadId}/comments — new comment (visibility
 * forced to `org` server-side).
 *
 * Requires a valid builder session; the guard provides the tenant_key.
 */
import {
  dispatchComments,
  type FunctionContext,
  type FunctionRequest,
} from './comments/shared';

export async function builderLeadCommentsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const leadId = context.bindingData?.['leadId'];
  await dispatchComments(
    context,
    req,
    (app) => {
      if (method === 'POST') {
        return app.builderCommentsRoute.createLeadComment(
          req.headers ?? {},
          leadId,
          req.body,
        );
      }
      return app.builderCommentsRoute.listLeadComments(req.headers ?? {}, leadId);
    },
    {
      path: '/api/v1/builder/leads/{leadId}/comments',
      guard: 'builder',
    },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderLeadCommentsHandler;
