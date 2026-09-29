/**
 * Permission guard tests (auth/04).
 *
 * - 401 for no valid session.
 * - 403 FORBIDDEN without leaking data when the permission is absent.
 * - Denied checks are audit-logged.
 * - requireBuilderId enforces server-side tenant scoping: a forged
 *   client-supplied builder id is 403 + audit, never honored.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/middleware/errors';
import {
  createPermissionGuard,
  type PermissionGuardDeps,
} from '../src/middleware/permission-guard';
import type { AuthContext } from '../src/services/auth-context.service';
import {
  effectivePermissions,
  type Permission,
} from '../src/auth/permissions';

function ctxWith(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    email: 'admin@example.com',
    name: 'Admin',
    staffRole: 'admin',
    permissions: effectivePermissions('admin', []),
    builderId: null,
    builderName: null,
    memberships: [],
    viewAs: null,
    realUser: null,
    ...overrides,
  };
}

function makeGuard(
  resolve: (headers: unknown) => Promise<AuthContext | null>,
) {
  const auditDenied = vi.fn(async (_args: unknown) => {});
  const auditViewAsAction = vi.fn(async (_args: unknown) => {});
  const authContext = {
    resolve,
    auditDenied,
    auditViewAsAction,
  };
  const guard = createPermissionGuard({
    authContext:
      authContext as unknown as PermissionGuardDeps['authContext'],
  });
  return { guard, auditDenied, auditViewAsAction };
}

const HEADERS = { authorization: 'Bearer <redacted>' };

describe('requirePermission (auth/04)', () => {
  it('returns 401 when there is no valid session', async () => {
    const { guard } = makeGuard(async () => null);
    const err = await guard
      .requirePermission('leads:read', HEADERS, 'GET /api/v1/admin/leads')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });

  it('returns the context when the permission is present', async () => {
    const ctx = ctxWith();
    const { guard } = makeGuard(async () => ctx);
    const out = await guard.requirePermission(
      'leads:read',
      HEADERS,
      'GET /api/v1/admin/leads',
    );
    expect(out).toBe(ctx);
  });

  it('supports requiring any-of several permissions', async () => {
    const ctx = ctxWith({
      permissions: effectivePermissions('viewer', []),
    });
    const { guard } = makeGuard(async () => ctx);
    const out = await guard.requirePermission(
      ['leads:manage', 'leads:read'],
      HEADERS,
      'GET /api/v1/admin/leads',
    );
    expect(out).toBe(ctx);
  });

  it('403 FORBIDDEN without leaking data when the permission is absent', async () => {
    const ctx = ctxWith({
      staffRole: 'viewer',
      permissions: effectivePermissions('viewer', []),
    });
    const { guard } = makeGuard(async () => ctx);
    const err = await guard
      .requirePermission(
        'leads:manage',
        HEADERS,
        'POST /api/v1/admin/leads/x/notes',
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const http = err as HttpError;
    expect(http.status).toBe(403);
    expect(http.code).toBe('FORBIDDEN');
    // The 403 body must not name the missing permission or the route's data.
    expect(http.message).not.toContain('leads:manage');
    expect(http.message).not.toContain('notes');
  });

  it('audit-logs denied authorization checks', async () => {
    const ctx = ctxWith({
      staffRole: 'viewer',
      permissions: effectivePermissions('viewer', []),
    });
    const { guard, auditDenied } = makeGuard(async () => ctx);
    await guard
      .requirePermission('leads:manage', HEADERS, 'POST /api/v1/admin/leads/x/notes')
      .catch(() => {});
    expect(auditDenied).toHaveBeenCalledTimes(1);
    const args = auditDenied.mock.calls[0]![0] as {
      ctx: AuthContext;
      permission: string;
      route: string;
    };
    expect(args.ctx.email).toBe('admin@example.com');
    expect(args.permission).toBe('leads:manage');
    expect(args.route).toBe('POST /api/v1/admin/leads/x/notes');
  });

  it('does not audit successful checks', async () => {
    const ctx = ctxWith();
    const { guard, auditDenied } = makeGuard(async () => ctx);
    await guard.requirePermission('leads:read', HEADERS, 'GET /api/v1/admin/leads');
    expect(auditDenied).not.toHaveBeenCalled();
  });
});

describe('requirePermissions ALL semantics + view-as action audit (auth/04)', () => {
  it('requires every permission (not any)', async () => {
    const ctx = ctxWith();
    const { guard } = makeGuard(async () => ctx);
    await expect(
      guard.requirePermissions(
        ['leads:read', 'super_admins:manage'],
        HEADERS,
        'GET /api/v1/admin/leads',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('audit-logs a successful action under the REAL admin while view-as is active', async () => {
    const ctx = ctxWith({
      email: 'target-builder@example.com',
      viewAs: { builderId: 'builder-1' },
      realUser: { userId: 'admin-1', email: 'real-admin@example.com', name: 'Real Admin' },
    });
    const { guard, auditViewAsAction } = makeGuard(async () => ctx);
    await guard.requirePermissions(
      ['leads:read'],
      HEADERS,
      'GET /api/v1/admin/leads',
    );
    expect(auditViewAsAction).toHaveBeenCalledTimes(1);
    const args = auditViewAsAction.mock.calls[0]![0] as {
      ctx: AuthContext;
      route: string;
    };
    // The audit layer resolves the real admin from ctx.realUser — the
    // guard must pass the full context through.
    expect(args.ctx.realUser?.email).toBe('real-admin@example.com');
    expect(args.route).toBe('GET /api/v1/admin/leads');
  });

  it('delegates view-as action auditing to the auth context service', async () => {
    // The guard always delegates; the service no-ops when ctx.viewAs is
    // null (covered in auth-context.service.test.ts). Non-view-as actions
    // are never audit-logged at this layer.
    const ctx = ctxWith();
    const { guard, auditViewAsAction } = makeGuard(async () => ctx);
    await guard.requirePermissions(
      ['leads:read'],
      HEADERS,
      'GET /api/v1/admin/leads',
    );
    expect(auditViewAsAction).toHaveBeenCalledTimes(1);
    expect(auditViewAsAction.mock.calls[0]![0]).toEqual({
      ctx,
      route: 'GET /api/v1/admin/leads',
    });
  });
});

describe('requireBuilderId tenant scoping (auth/04)', () => {
  it('returns the session builder id for tenant scoping', async () => {
    const ctx = ctxWith({ builderId: 'builder-9' });
    const { guard } = makeGuard(async () => ctx);
    await expect(
      guard.requireBuilderId(ctx, 'GET /api/v1/builder/leads'),
    ).resolves.toBe('builder-9');
  });

  it('403 + audit when the session carries no builder context (forged client id is never honored)', async () => {
    const ctx = ctxWith({ builderId: null });
    const { guard, auditDenied } = makeGuard(async () => ctx);
    const err = await guard
      .requireBuilderId(ctx, 'GET /api/v1/builder/leads')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(auditDenied).toHaveBeenCalledTimes(1);
    const args = auditDenied.mock.calls[0]![0] as { permission: string };
    expect(args.permission).toBe('builder-context');
  });
});

describe('builder team invite route (auth/05)', () => {
  const INVITE_ROUTE = 'POST /api/v1/builder/users/invite';

  function memberCtx(): AuthContext {
    return ctxWith({
      staffRole: null,
      builderId: 'builder-9',
      memberships: [
        { builderId: 'builder-9', role: 'builder_member', createdAt: new Date() },
      ],
      permissions: effectivePermissions(null, ['builder_member']),
    });
  }

  function adminCtx(): AuthContext {
    return ctxWith({
      staffRole: null,
      builderId: 'builder-9',
      memberships: [
        { builderId: 'builder-9', role: 'builder_admin', createdAt: new Date() },
      ],
      permissions: effectivePermissions(null, ['builder_admin']),
    });
  }

  it('builder_member is 403 on POST /api/v1/builder/users/invite', async () => {
    const { guard, auditDenied } = makeGuard(async () => memberCtx());
    const err = await guard
      .requirePermission('builder:users:manage', HEADERS, INVITE_ROUTE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const http = err as HttpError;
    expect(http.status).toBe(403);
    expect(http.code).toBe('FORBIDDEN');
    expect(auditDenied).toHaveBeenCalledTimes(1);
    expect(auditDenied.mock.calls[0]![0]).toMatchObject({
      permission: 'builder:users:manage',
      route: INVITE_ROUTE,
    });
  });

  it('builder_admin passes POST /api/v1/builder/users/invite', async () => {
    const ctx = adminCtx();
    const { guard } = makeGuard(async () => ctx);
    const out = await guard.requirePermission(
      'builder:users:manage',
      HEADERS,
      INVITE_ROUTE,
    );
    expect(out).toBe(ctx);
  });

  it('no session is 401 on POST /api/v1/builder/users/invite', async () => {
    const { guard } = makeGuard(async () => null);
    const err = await guard
      .requirePermission('builder:users:manage', HEADERS, INVITE_ROUTE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });
});

describe('getAuthContext', () => {
  it('returns null when unauthenticated (route maps it to 401)', async () => {
    const { guard } = makeGuard(async () => null);
    await expect(guard.getAuthContext(HEADERS)).resolves.toBeNull();
  });

  it('returns the context without a permission check', async () => {
    const ctx = ctxWith({ permissions: [] as Permission[] });
    const { guard } = makeGuard(async () => ctx);
    await expect(guard.getAuthContext(HEADERS)).resolves.toBe(ctx);
  });
});
