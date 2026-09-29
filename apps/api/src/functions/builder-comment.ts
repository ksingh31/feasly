/**
 * Azure Functions v3 trigger adapter — single comment edit (builder).
 *
 * PATCH /api/v1/builder/comments/{commentId} — author-only edit.
 *
 * No builder DELETE route exists (builders cannot delete comments);
 * `test/route-registry.conformance.test.ts` asserts this.
 *
 * Requires a valid builder session; the guard provides the tenant_key.
 */
import {
  dispatchComments,
  type FunctionContext,
  type FunctionRequest,
} from './comments/shared';

export async function builderCommentHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  const commentId = context.bindingData?.['commentId'];
  await dispatchComments(
    context,
    req,
    (app) =>
      app.builderCommentsRoute.updateComment(
        req.headers ?? {},
        commentId,
        req.body,
      ),
    {
      path: '/api/v1/builder/comments/{commentId}',
      guard: 'builder',
    },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderCommentHandler;
