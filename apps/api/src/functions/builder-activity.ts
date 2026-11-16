/**
 * Azure Functions v3 trigger adapter — GET /api/v1/builder/activity.
 *
 * Builder org activity history (#728): team-wide for owner/admins, own actions for members.
 * Registry permissions are enforced in the shared dispatcher.
 *
 * Bundled by `npm run bundle:functions` into `builder-activity/index.js`.
 */
import {
  dispatchAuditFinance,
  type FunctionContext,
  type FunctionRequest,
} from './audit-finance/shared';

export async function builderActivityHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAuditFinance(
    context,
    req,
    (app, headers) => app.auditFinanceRoute.builderActivity(headers, req.query ?? {}),
    { path: '/api/v1/builder/activity' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = builderActivityHandler;
