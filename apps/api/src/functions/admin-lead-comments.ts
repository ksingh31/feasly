/**
 * Azure Functions v3 trigger adapter — lead comment thread (admin).
 *
 * GET /api/v1/admin/leads/{leadId}/comments — full thread, including
 * `admin_only` rows.
 * POST /api/v1/admin/leads/{leadId}/comments — new comment (defaults to
 * `admin_only` unless `org` is explicitly requested).
 *
 * Admin-gated via the AdminGuard (inside the route).
 */
import {
  dispatchComments,
  type FunctionContext,
  type FunctionRequest,
} from './comments/shared';

export async function adminLeadCommentsHandler(
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
        return app.adminCommentsRoute.createLeadComment(
          req.headers ?? {},
          leadId,
          req.body,
        );
      }
      return app.adminCommentsRoute.listLeadComments(req.headers ?? {}, leadId);
    },
    {
      path: '/api/v1/admin/leads/{leadId}/comments',
      guard: 'admin',
    },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadCommentsHandler;
