/**
 * Azure Functions v3 trigger adapter — single comment edit/delete (admin).
 *
 * PATCH /api/v1/admin/comments/{commentId} — author-only edit.
 * DELETE /api/v1/admin/comments/{commentId} — soft delete (the row stays
 * in the database; both read paths exclude it in SQL).
 *
 * Admin-gated via the AdminGuard (inside the route).
 */
import {
  dispatchComments,
  type FunctionContext,
  type FunctionRequest,
} from './comments/shared';

export async function adminCommentHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const commentId = context.bindingData?.['commentId'];
  await dispatchComments(
    context,
    req,
    (app) => {
      if (method === 'DELETE') {
        return app.adminCommentsRoute.deleteComment(
          req.headers ?? {},
          commentId,
        );
      }
      return app.adminCommentsRoute.updateComment(
        req.headers ?? {},
        commentId,
        req.body,
      );
    },
    {
      path: '/api/v1/admin/comments/{commentId}',
      guard: 'admin',
    },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminCommentHandler;
