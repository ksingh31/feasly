/**
 * Azure Functions v3 trigger adapter — POST /api/v1/admin/leads/{id}/notes.
 *
 * Append a note to a lead (append-only). Admin-gated via the
 * session-cookie AdminGuard (inside the route).
 *
 * Bundled by `npm run bundle:functions` into `admin-leads-notes/index.js`.
 */
import {
  dispatchAdminLeads,
  type FunctionContext,
  type FunctionRequest,
} from './admin-leads/shared';

export async function adminLeadsNotesHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminLeads(context, req, (app) =>
    app.adminLeadsRoute.addNote(
      req.headers ?? {},
      context.bindingData?.['id'],
      req.body,
    ),
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminLeadsNotesHandler;
