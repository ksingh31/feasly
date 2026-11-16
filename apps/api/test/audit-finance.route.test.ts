/**
 * #728 audit/finance route — thin adapter tests: the right guard runs,
 * builder calls take the tenant from the session, and the activity scope
 * follows `builder:activity:team`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAuditFinanceRoute } from '../src/routes/audit-finance.route';
import type { AuditFinanceService } from '../src/services/audit-finance.service';
import type { AuthContext } from '../src/services/auth-context.service';
import { ROLE_PERMISSIONS } from '../src/auth/permissions';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const H = { authorization: 'Bearer t' };
const SESSION = { email: 'owner@elite.test', tenantKey: 'elite-craft', builderId: 'b-1', viewAs: null };

function ctx(role: 'builder_admin' | 'builder_member'): AuthContext {
  return {
    userId: 'u-1',
    email: 'owner@elite.test',
    name: 'Owner',
    staffRole: null,
    permissions: ROLE_PERMISSIONS[role],
    builderId: 'b-1',
    builderName: 'Elite',
    memberships: [],
    viewAs: null,
    realUser: null,
  };
}

function makeRoute(opts: { session?: typeof SESSION | null; role?: 'builder_admin' | 'builder_member'; admin?: boolean } = {}) {
  const service: AuditFinanceService = {
    listAudit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    financeSummary: vi.fn(),
    exportInvoices: vi.fn().mockResolvedValue({ csv: 'a\r\n', filename: 'f.csv' }),
    builderActivity: vi.fn().mockResolvedValue({ scope: 'self', items: [], nextCursor: null }),
  };
  const adminGuard = {
    requireAdmin: vi.fn(async () => {
      if (opts.admin === false) {
        throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.', false);
      }
    }),
    getAdminEmail: vi.fn().mockResolvedValue('karan@feasly.test'),
  };
  const route = createAuditFinanceRoute({
    service,
    adminGuard,
    builderGuard: {
      getBuilderSession: vi.fn().mockResolvedValue(opts.session === undefined ? SESSION : opts.session),
    },
    permissionGuard: { getAuthContext: vi.fn().mockResolvedValue(ctx(opts.role ?? 'builder_admin')) },
  });
  return { route, service, adminGuard };
}

describe('audit-finance route', () => {
  it('admin endpoints require an admin session', async () => {
    const { route, service } = makeRoute({ admin: false });
    await expect(route.listAudit(H, {})).rejects.toMatchObject({ status: 401 });
    await expect(route.adminExportInvoices(H, {})).rejects.toMatchObject({ status: 401 });
    expect(service.listAudit).not.toHaveBeenCalled();
  });

  it('admin export runs as staff with the session email', async () => {
    const { route, service } = makeRoute();
    await route.adminExportInvoices(H, { tenantKey: 'elite-craft' });
    expect(service.exportInvoices).toHaveBeenCalledWith(
      { tenantKey: 'elite-craft' },
      { kind: 'staff', email: 'karan@feasly.test' },
    );
  });

  it('builder export takes the tenant from the session', async () => {
    const { route, service } = makeRoute();
    await route.builderExportInvoices(H, { tenantKey: 'other' });
    expect(service.exportInvoices).toHaveBeenCalledWith(
      { tenantKey: 'other' },
      { kind: 'builder', email: SESSION.email, tenantKey: 'elite-craft', builderId: 'b-1' },
    );
  });

  it('builder endpoints 401 without a builder session', async () => {
    const { route } = makeRoute({ session: null });
    await expect(route.builderExportInvoices(H, {})).rejects.toMatchObject({ status: 401 });
    await expect(route.builderActivity(H, {})).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    ['builder_admin', true],
    ['builder_member', false],
  ] as const)('activity scope for %s: team=%s', async (role, team) => {
    const { route, service } = makeRoute({ role });
    await route.builderActivity(H, {});
    expect(service.builderActivity).toHaveBeenCalledWith(
      {},
      { email: 'owner@elite.test', tenantKey: 'elite-craft', builderId: 'b-1', team },
    );
  });
});
