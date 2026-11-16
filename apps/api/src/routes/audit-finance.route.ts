/**
 * Thin audit viewer / finance export / builder activity route (#728).
 * Routes are adapters, not logic: require auth → call exactly one service
 * method → return the result. Registry permissions are enforced by the
 * Function adapter before any of these run.
 *
 * - `GET /api/v1/admin/audit` — merged admin + billing audit trail
 *   (`audit:read`).
 * - `GET /api/v1/admin/billing/summary` — period finance summary
 *   (`finance:export`).
 * - `GET /api/v1/admin/billing/invoices/export.csv` — invoice CSV, every
 *   tenant or one (`finance:export`).
 * - `GET /api/v1/billing/invoices/export.csv` — the builder's own invoice
 *   CSV (`builder:billing`); the tenant comes from the session, never the
 *   request.
 * - `GET /api/v1/builder/activity` — the builder org's activity
 *   (`builder:activity:read`); team-wide with `builder:activity:team`,
 *   otherwise the caller's own actions only.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type {
  AuditLogListResponse,
  BuilderActivityResponse,
  FinanceSummary,
} from '@feasly/contracts';
import { hasPermission } from '../auth/permissions';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BuilderGuard } from '../middleware/builder-guard';
import type { PermissionGuard } from '../middleware/permission-guard';
import type { AuditFinanceService } from '../services/audit-finance.service';

type Headers = Record<string, string | string[] | undefined>;
type Query = Record<string, unknown>;

export interface AuditFinanceRouteDeps {
  readonly service: AuditFinanceService;
  readonly adminGuard: AdminGuard;
  readonly builderGuard: Pick<BuilderGuard, 'getBuilderSession'>;
  readonly permissionGuard: Pick<PermissionGuard, 'getAuthContext'>;
}

export interface CsvResult {
  readonly csv: string;
  readonly filename: string;
}

export interface AuditFinanceRoute {
  listAudit(headers: Headers, query: Query): Promise<AuditLogListResponse>;
  financeSummary(headers: Headers, query: Query): Promise<FinanceSummary>;
  adminExportInvoices(headers: Headers, query: Query): Promise<CsvResult>;
  builderExportInvoices(headers: Headers, query: Query): Promise<CsvResult>;
  builderActivity(headers: Headers, query: Query): Promise<BuilderActivityResponse>;
}

function unauthenticated(): HttpError {
  return new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Builder authentication required.', false);
}

export function createAuditFinanceRoute(deps: AuditFinanceRouteDeps): AuditFinanceRoute {
  const { service, adminGuard, builderGuard, permissionGuard } = deps;

  async function requireAdminEmail(headers: Headers): Promise<string> {
    await adminGuard.requireAdmin(headers);
    return (await adminGuard.getAdminEmail(headers)) ?? 'admin@session';
  }

  return {
    async listAudit(headers, query) {
      await adminGuard.requireAdmin(headers);
      return service.listAudit(query);
    },

    async financeSummary(headers, query) {
      await adminGuard.requireAdmin(headers);
      return service.financeSummary(query);
    },

    async adminExportInvoices(headers, query) {
      const email = await requireAdminEmail(headers);
      return service.exportInvoices(query, { kind: 'staff', email });
    },

    async builderExportInvoices(headers, query) {
      const session = await builderGuard.getBuilderSession(headers);
      if (!session) throw unauthenticated();
      return service.exportInvoices(query, {
        kind: 'builder',
        email: session.email,
        tenantKey: session.tenantKey,
        builderId: session.builderId,
      });
    },

    async builderActivity(headers, query) {
      const session = await builderGuard.getBuilderSession(headers);
      if (!session) throw unauthenticated();
      const ctx = await permissionGuard.getAuthContext(headers);
      if (!ctx) throw unauthenticated();
      return service.builderActivity(query, {
        email: ctx.email,
        tenantKey: session.tenantKey,
        builderId: session.builderId,
        team: hasPermission(ctx.permissions, 'builder:activity:team'),
      });
    },
  };
}
