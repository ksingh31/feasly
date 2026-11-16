/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/ops/jobs (#838).
 *
 * Admin view of the Postgres-backed job queue: per-status counts plus the
 * latest jobs in one status (default `dead` — failed jobs). Admin-gated
 * (session-cookie AdminGuard inside the route + registry permissions).
 *
 * Bundled by `npm run bundle:functions` into `admin-jobs/index.js`.
 */
import {
  dispatchAdminSheets,
  type FunctionContext,
  type FunctionRequest,
} from './admin-sheets/shared';

export async function adminJobsHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAdminSheets(
    context,
    req,
    (app) => app.adminJobsRoute.list(req.headers ?? {}, req.query ?? {}),
    { path: '/api/v1/admin/ops/jobs' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminJobsHandler;
