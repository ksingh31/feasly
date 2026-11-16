/**
 * Azure Functions v3 trigger adapter — GET /api/v1/admin/audit.
 *
 * Merged admin + billing audit trail, newest first, keyset-paginated (#728).
 * Registry permissions are enforced in the shared dispatcher.
 *
 * Bundled by `npm run bundle:functions` into `admin-audit/index.js`.
 */
import {
  dispatchAuditFinance,
  type FunctionContext,
  type FunctionRequest,
} from './audit-finance/shared';

export async function adminAuditHandler(
  context: FunctionContext,
  req: FunctionRequest,
): Promise<void> {
  await dispatchAuditFinance(
    context,
    req,
    (app, headers) => app.auditFinanceRoute.listAudit(headers, req.query ?? {}),
    { path: '/api/v1/admin/audit' },
  );
}

// Azure Functions v3 programming model entry point (bundled as CJS).
module.exports = adminAuditHandler;
