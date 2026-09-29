/**
 * Admin billing money actions — authorization acceptance.
 *
 * POST /api/v1/admin/billing/invoices/{id}/mark-paid and
 * POST /api/v1/admin/billing/invoices/{id}/commission-rate are
 * platform-admin-only (`billing:manage` in the route registry). This pins the
 * CENTRAL enforcement point (`enforceRoutePermissions`, which every
 * Function adapter runs before the route):
 *
 * - a builder member / builder admin session (valid login, but the role
 *   lacks `billing:manage`) → 403 FORBIDDEN, audit-logged, no data leak;
 * - a platform admin session → passes the permission gate;
 * - no session → 401 UNAUTHENTICATED.
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { enforceRoutePermissions } from '../src/middleware/enforce-route-permissions';
import {
  createPermissionGuard,
  type PermissionGuardDeps,
} from '../src/middleware/permission-guard';
import { effectivePermissions } from '../src/auth/permissions';
import type { AuthContext } from '../src/services/auth-context.service';
import type { BuilderRole, StaffRole } from '../src/services/user.service';

const MARK_PAID = '/api/v1/admin/billing/invoices/{id}/mark-paid';
const SET_RATE = '/api/v1/admin/billing/invoices/{id}/commission-rate';
const HEADERS = { authorization: 'Bearer <redacted>' };

function ctxFor(
  staffRole: StaffRole | null,
  members: BuilderRole[],
): AuthContext {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    name: 'User',
    staffRole,
    permissions: effectivePermissions(staffRole, members),
    builderId: members.length > 0 ? 'builder-1' : null,
    builderName: members.length > 0 ? 'Test Builder' : null,
    memberships: members.map((role) => ({
      builderId: 'builder-1',
      role,
      createdAt: new Date('2026-09-29T00:00:00Z'),
    })),
    viewAs: null,
    realUser: null,
  };
}

function makeHarness(ctx: AuthContext | null) {
  const auditDenied = vi.fn(async (_args: unknown) => {});
  const authContext = {
    resolve: async () => ctx,
    auditDenied,
    auditViewAsAction: vi.fn(async (_args: unknown) => {}),
  };
  const guard = createPermissionGuard({
    authContext: authContext as unknown as PermissionGuardDeps['authContext'],
  });
  return { guard, auditDenied };
}

describe('admin billing money actions — central permission enforcement', () => {
  for (const path of [MARK_PAID, SET_RATE]) {
    it(`403s a builder_member session on POST ${path}`, async () => {
      const { guard, auditDenied } = makeHarness(ctxFor(null, ['builder_member']));
      const err = await enforceRoutePermissions(guard, 'POST', path, HEADERS).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).code).toBe(ErrorCodes.FORBIDDEN);
      expect(auditDenied).toHaveBeenCalledTimes(1);
    });

    it(`403s a builder_admin session on POST ${path}`, async () => {
      const err = await enforceRoutePermissions(
        makeHarness(ctxFor(null, ['builder_admin'])).guard,
        'POST',
        path,
        HEADERS,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).code).toBe(ErrorCodes.FORBIDDEN);
    });

    it(`passes a platform admin session on POST ${path}`, async () => {
      await expect(
        enforceRoutePermissions(
          makeHarness(ctxFor('admin', [])).guard,
          'POST',
          path,
          HEADERS,
        ),
      ).resolves.toBeUndefined();
    });

    it(`401s with no session on POST ${path}`, async () => {
      const err = await enforceRoutePermissions(
        makeHarness(null).guard,
        'POST',
        path,
        HEADERS,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
      expect((err as HttpError).code).toBe(ErrorCodes.UNAUTHENTICATED);
    });
  }

  it('sanity: builder roles never carry the platform billing:manage gate', async () => {
    // builder_admin can see its OWN org invoices via `builder:billing` —
    // that must never satisfy the platform `billing:manage` gate.
    const adminCtx = ctxFor(null, ['builder_admin']);
    expect(adminCtx.permissions).toContain('builder:billing');
    expect(adminCtx.permissions).not.toContain('billing:manage');
    const memberCtx = ctxFor(null, ['builder_member']);
    expect(memberCtx.permissions).not.toContain('billing:manage');
  });
});
