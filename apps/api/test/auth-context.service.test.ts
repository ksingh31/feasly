/**
 * Auth context resolution tests (auth/04).
 *
 * The AuthContextService turns a session into effective permissions plus
 * the server-side builder tenant. Fail-closed throughout: disabled users,
 * unknown view-as targets, and stale active builders all lose access
 * rather than inheriting anything.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAuthContextService,
  type AuthContextServiceDeps,
} from '../src/services/auth-context.service';
import {
  hashSessionToken,
  type AdminSessionRecord,
} from '../src/services/admin-auth.service';
import type { BuilderSession } from '../src/services/builder-auth.service';
import type {
  BuilderMembership,
  UserRecord,
} from '../src/services/user.service';
import { effectivePermissions } from '../src/auth/permissions';
import { HttpError } from '../src/middleware/errors';
import { createPermissionGuard } from '../src/middleware/permission-guard';
import { BUILDER_STATUSES, BUILDER_STATUS_POLICY } from '@feasly/contracts';

const NOW = new Date('2026-09-28T12:00:00Z');

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-admin',
    email: 'admin@example.com',
    name: 'Admin User',
    status: 'active',
    staffRole: 'admin',
    entraObjectId: 'entra-1',
    isProtected: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function adminSession(
  token: string,
  overrides: Partial<AdminSessionRecord> = {},
): AdminSessionRecord {
  return {
    id: 'sess-1',
    email: 'admin@example.com',
    sessionTokenHash: hashSessionToken(token),
    idToken: null,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 3600 * 1000),
    createdAt: NOW,
    userId: 'user-admin',
    activeBuilderId: null,
    viewAs: null,
    ...overrides,
  };
}

interface Fixture {
  service: ReturnType<typeof createAuthContextService>;
  audit: { log: ReturnType<typeof vi.fn> };
  adminSessions: Map<string, AdminSessionRecord>;
  builderSessions: Map<string, BuilderSession>;
  usersByEmail: Map<string, UserRecord>;
  usersById: Map<string, UserRecord>;
  membershipsByUser: Map<string, BuilderMembership[]>;
  buildersById: Map<string, { id: string; displayName: string; status: string }>;
}

function makeService(): Fixture {
  const adminSessions = new Map<string, AdminSessionRecord>();
  const builderSessions = new Map<string, BuilderSession>();
  const usersByEmail = new Map<string, UserRecord>();
  const usersById = new Map<string, UserRecord>();
  const membershipsByUser = new Map<string, BuilderMembership[]>();
  const buildersById = new Map<
    string,
    { id: string; displayName: string; status: string }
  >();
  const audit = { log: vi.fn(async () => {}) };

  const deps = {
    adminSessions: {
      findActiveByHash: async (hash: string) => adminSessions.get(hash) ?? null,
    },
    builderAuth: {
      validateSession: async (token: string | null) =>
        token ? (builderSessions.get(token) ?? null) : null,
    },
    users: {
      findByEmail: async (email: string) =>
        usersByEmail.get(email.toLowerCase()) ?? null,
      findById: async (id: string) => usersById.get(id) ?? null,
    },
    memberships: {
      listByUserId: async (userId: string) =>
        membershipsByUser.get(userId) ?? [],
    },
    builders: {
      getBuilder: async (id: string) => {
        const b = buildersById.get(id);
        if (!b) throw new Error('not found');
        return b;
      },
      getByTenantKey: async () => null,
    },
    audit,
    clock: () => NOW,
  } as unknown as AuthContextServiceDeps;

  return {
    service: createAuthContextService(deps),
    audit,
    adminSessions,
    builderSessions,
    usersByEmail,
    usersById,
    membershipsByUser,
    buildersById,
  };
}

function seedAdmin(fx: Fixture, token = 'admin-token'): void {
  fx.adminSessions.set(hashSessionToken(token), adminSession(token));
  const u = user();
  fx.usersByEmail.set(u.email.toLowerCase(), u);
  fx.usersById.set(u.id, u);
  fx.buildersById.set('builder-1', {
    id: 'builder-1',
    displayName: 'Elite Craft',
    status: 'active',
  });
}

const HEADERS = (token: string) => ({ authorization: `Bearer ${token}` });
// Builder sessions ride the httpOnly builder cookie same-origin; the
// cross-origin SPA sends the same token as a Bearer header instead.
const BUILDER_HEADERS = (token: string) => ({
  cookie: `feasly_builder_session=${token}`,
});

describe('auth context resolution (auth/04)', () => {
  it('returns null when no session resolves', async () => {
    const fx = makeService();
    await expect(
      fx.service.resolve(HEADERS('nope')),
    ).resolves.toBeNull();
  });

  it('resolves staff + membership permissions and the active builder', async () => {
    const fx = makeService();
    seedAdmin(fx);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { activeBuilderId: 'builder-1' }),
    );
    fx.membershipsByUser.set('user-admin', [
      { builderId: 'builder-1', role: 'builder_member', createdAt: NOW },
    ]);
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.staffRole).toBe('admin');
    expect(ctx!.permissions).toEqual(
      expect.arrayContaining(effectivePermissions('admin', ['builder_member'])),
    );
    expect(ctx!.builderId).toBe('builder-1');
    expect(ctx!.builderName).toBe('Elite Craft');
    expect(ctx!.viewAs).toBeNull();
    expect(ctx!.realUser).toBeNull();
  });

  it('disabled users lose access immediately', async () => {
    const fx = makeService();
    seedAdmin(fx);
    const u = user({ status: 'disabled' });
    fx.usersByEmail.set(u.email.toLowerCase(), u);
    fx.usersById.set(u.id, u);
    await expect(
      fx.service.resolve(HEADERS('admin-token')),
    ).resolves.toBeNull();
  });

  it('valid user with no roles and no memberships gets empty access', async () => {
    const fx = makeService();
    seedAdmin(fx);
    const u = user({ id: 'user-plain', staffRole: null });
    fx.usersByEmail.set('plain@example.com', u);
    fx.usersById.set('user-plain', u);
    fx.adminSessions.set(
      hashSessionToken('plain-token'),
      adminSession('plain-token', {
        email: 'plain@example.com',
        userId: 'user-plain',
      }),
    );
    const ctx = await fx.service.resolve(HEADERS('plain-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.permissions).toEqual([]);
    expect(ctx!.builderId).toBeNull();
  });

  it('active builder outside the memberships is dropped (never trusted)', async () => {
    const fx = makeService();
    seedAdmin(fx);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { activeBuilderId: 'builder-evil' }),
    );
    fx.membershipsByUser.set('user-admin', [
      { builderId: 'builder-1', role: 'builder_admin', createdAt: NOW },
    ]);
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.builderId).toBeNull();
  });

  it('legacy magic-link session (no user row) maps to conservative admin', async () => {
    const fx = makeService();
    fx.adminSessions.set(
      hashSessionToken('legacy-token'),
      adminSession('legacy-token', { userId: null }),
    );
    const ctx = await fx.service.resolve(HEADERS('legacy-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.permissions).toEqual(
      expect.arrayContaining(effectivePermissions('admin', [])),
    );
  });
});

describe('view-as resolution (auth/04)', () => {
  it('view-as builder resolves the builder-admin view, preserving the real admin', async () => {
    const fx = makeService();
    seedAdmin(fx);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { viewAs: { builderId: 'builder-1' } }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx).not.toBeNull();
    // The borrowed builder view is the builder_admin set MINUS view_as:
    // view-as is terminal — a view-as session can never chain into another.
    expect(ctx!.permissions).toEqual(
      expect.arrayContaining(
        effectivePermissions(null, ['builder_admin']).filter(
          (p) => p !== 'view_as',
        ),
      ),
    );
    expect(ctx!.permissions).not.toContain('view_as');
    expect(ctx!.builderId).toBe('builder-1');
    expect(ctx!.realUser).toEqual({
      userId: 'user-admin',
      email: 'admin@example.com',
      name: 'Admin User',
    });
  });

  it('view-as user resolves the target user\u2019s exact permissions', async () => {
    const fx = makeService();
    seedAdmin(fx);
    const target = user({
      id: 'user-viewer',
      email: 'viewer@example.com',
      name: 'Viewer User',
      staffRole: 'viewer',
    });
    fx.usersByEmail.set('viewer@example.com', target);
    fx.usersById.set('user-viewer', target);
    fx.membershipsByUser.set('user-viewer', [
      { builderId: 'builder-1', role: 'builder_member', createdAt: NOW },
    ]);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { viewAs: { userId: 'user-viewer' } }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx).not.toBeNull();
    expect(new Set(ctx!.permissions)).toEqual(
      new Set(effectivePermissions('viewer', ['builder_member'])),
    );
    expect(ctx!.builderId).toBe('builder-1');
    expect(ctx!.realUser?.email).toBe('admin@example.com');
  });

  it('unknown view-as user target fails closed — never the real admin\u2019s permissions', async () => {
    const fx = makeService();
    seedAdmin(fx);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { viewAs: { userId: 'user-gone' } }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.permissions).toEqual([]);
    expect(ctx!.builderId).toBeNull();
    // The real identity is still preserved for the audit trail.
    expect(ctx!.realUser?.email).toBe('admin@example.com');
  });

  it('disabled view-as user target fails closed', async () => {
    const fx = makeService();
    seedAdmin(fx);
    const target = user({
      id: 'user-gone',
      email: 'gone@example.com',
      status: 'disabled',
      staffRole: 'super_admin',
    });
    fx.usersByEmail.set('gone@example.com', target);
    fx.usersById.set('user-gone', target);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { viewAs: { userId: 'user-gone' } }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx).not.toBeNull();
    // Must NOT inherit the disabled super_admin's permissions.
    expect(ctx!.permissions).toEqual([]);
  });

  it('unknown view-as builder target fails closed', async () => {
    const fx = makeService();
    seedAdmin(fx);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { viewAs: { builderId: 'builder-gone' } }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.permissions).toEqual([]);
    expect(ctx!.builderId).toBeNull();
  });
});

describe('builder session resolution (auth/04)', () => {
  it('resolves the builder tenant from the session builder id', async () => {
    const fx = makeService();
    fx.buildersById.set('builder-7', {
      id: 'builder-7',
      displayName: 'North Homes',
      status: 'active',
    });
    fx.builderSessions.set('builder-token', {
      email: 'portal@example.com',
      tenantKey: 'north-homes',
      viewAs: null,
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(BUILDER_HEADERS('builder-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.builderId).toBe('builder-7');
    expect(ctx!.permissions).toEqual(
      expect.arrayContaining(effectivePermissions(null, ['builder_admin'])),
    );
  });

  it('prefers the user model membership role over the legacy mapping', async () => {
    const fx = makeService();
    fx.buildersById.set('builder-7', {
      id: 'builder-7',
      displayName: 'North Homes',
      status: 'active',
    });
    fx.builderSessions.set('builder-token', {
      email: 'member@example.com',
      tenantKey: 'north-homes',
      viewAs: null,
      builderId: 'builder-7',
    });
    const u = user({
      id: 'user-member',
      email: 'member@example.com',
      staffRole: null,
    });
    fx.usersByEmail.set('member@example.com', u);
    fx.usersById.set('user-member', u);
    fx.membershipsByUser.set('user-member', [
      { builderId: 'builder-7', role: 'builder_member', createdAt: NOW },
    ]);
    const ctx = await fx.service.resolve(BUILDER_HEADERS('builder-token'));
    expect(ctx).not.toBeNull();
    expect(new Set(ctx!.permissions)).toEqual(
      new Set(effectivePermissions(null, ['builder_member'])),
    );
  });

  // #860: sign-in enforcement point — one test per status.
  it.each(BUILDER_STATUSES)('a %s builder\'s session follows the signIn policy', async (status) => {
    const fx = makeService();
    fx.buildersById.set('builder-7', { id: 'builder-7', displayName: 'North Homes', status });
    fx.builderSessions.set('builder-token', {
      email: 'portal@example.com',
      tenantKey: 'north-homes',
      viewAs: null,
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(BUILDER_HEADERS('builder-token'));
    if (BUILDER_STATUS_POLICY[status].signIn) {
      expect(ctx?.builderId).toBe('builder-7');
    } else {
      expect(ctx).toBeNull();
    }
  });

  it('unknown builder on the session denies the session', async () => {
    const fx = makeService();
    fx.builderSessions.set('builder-token', {
      email: 'portal@example.com',
      tenantKey: 'ghost',
      viewAs: null,
      builderId: 'builder-ghost',
    });
    await expect(
      fx.service.resolve(BUILDER_HEADERS('builder-token')),
    ).resolves.toBeNull();
  });

  it('a builder Bearer token falls through admin resolution to the builder session', async () => {
    // Regression: the cross-origin SPA sends the builder session as
    // `Authorization: Bearer <token>` (the httpOnly cookie never sticks
    // cross-origin). resolve() must not treat it as a failed ADMIN token
    // and deny — it falls through to the builder store.
    const fx = makeService();
    fx.buildersById.set('builder-7', {
      id: 'builder-7',
      displayName: 'North Homes',
      status: 'active',
    });
    fx.builderSessions.set('builder-token', {
      email: 'portal@example.com',
      tenantKey: 'north-homes',
      viewAs: null,
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(HEADERS('builder-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.builderId).toBe('builder-7');
    expect(ctx!.permissions).toEqual(
      expect.arrayContaining(effectivePermissions(null, ['builder_admin'])),
    );
  });

  it('a Bearer token in neither store resolves to null', async () => {
    const fx = makeService();
    await expect(fx.service.resolve(HEADERS('garbage'))).resolves.toBeNull();
  });
});

describe('view-as action auditing (auth/04)', () => {
  it('auditViewAsAction logs the action under the REAL admin while view-as is active', async () => {
    const fx = makeService();
    await fx.service.auditViewAsAction({
      ctx: {
        viewAs: { builderId: 'builder-1' },
        realUser: {
          userId: 'user-admin',
          email: 'admin@example.com',
          name: 'Admin User',
        },
        email: 'target@example.com',
      } as never,
      route: 'GET /api/v1/admin/leads',
    });
    expect(fx.audit.log).toHaveBeenCalledTimes(1);
    expect(fx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: 'admin@example.com',
        action: 'authz.view_as_action',
        detail: 'route=GET /api/v1/admin/leads view_as=1',
      }),
    );
  });

  it('auditViewAsAction is a no-op when view-as is not active', async () => {
    const fx = makeService();
    await fx.service.auditViewAsAction({
      ctx: { viewAs: null, realUser: null, email: 'admin@example.com' } as never,
      route: 'GET /api/v1/admin/leads',
    });
    expect(fx.audit.log).not.toHaveBeenCalled();
  });
});

describe('builder-side view-as context resolution (2026-09-30, Karan)', () => {
  function builderAdminFixture() {
    const fx = makeService();
    fx.buildersById.set('builder-7', {
      id: 'builder-7',
      displayName: 'North Homes',
      status: 'active',
    });
    const adminUser = {
      id: 'user-builder-admin',
      email: 'builderadmin@example.com',
      name: 'Builder Admin',
      status: 'active',
      staffRole: null,
      entraObjectId: 'entra-b1',
      isProtected: false,
      createdAt: NOW,
      updatedAt: NOW,
    } as UserRecord;
    fx.usersByEmail.set('builderadmin@example.com', adminUser);
    fx.usersById.set('user-builder-admin', adminUser);
    fx.membershipsByUser.set('user-builder-admin', [
      { builderId: 'builder-7', role: 'builder_admin', createdAt: NOW },
    ] as BuilderMembership[]);
    const memberUser = {
      id: 'user-member',
      email: 'member@example.com',
      name: 'Team Member',
      status: 'active',
      staffRole: null,
      entraObjectId: 'entra-m1',
      isProtected: false,
      createdAt: NOW,
      updatedAt: NOW,
    } as UserRecord;
    fx.usersById.set('user-member', memberUser);
    fx.membershipsByUser.set('user-member', [
      { builderId: 'builder-7', role: 'builder_member', createdAt: NOW },
    ] as BuilderMembership[]);
    return fx;
  }

  function resolveHeaders(token: string) {
    return { cookie: `feasly_builder_session=${token}` };
  }

  it('resolves the target\u2019s view: fresh target permissions, target org, real identity on realUser', async () => {
    const fx = builderAdminFixture();
    fx.builderSessions.set('builder-token', {
      email: 'builderadmin@example.com',
      tenantKey: 'north-homes',
      viewAs: { userId: 'user-member' },
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(resolveHeaders('builder-token'));
    expect(ctx).not.toBeNull();
    // The target's view: their identity, their (member) permissions...
    expect(ctx!.userId).toBe('user-member');
    expect(ctx!.email).toBe('member@example.com');
    expect(ctx!.name).toBe('Team Member');
    expect(ctx!.permissions).toEqual(
      effectivePermissions(null, ['builder_member']),
    );
    expect(ctx!.builderId).toBe('builder-7');
    expect(ctx!.builderName).toBe('North Homes');
    // ...the viewAs flag, and the REAL admin on realUser.
    expect(ctx!.viewAs).toEqual({ userId: 'user-member' });
    expect(ctx!.realUser).toEqual({
      userId: 'user-builder-admin',
      email: 'builderadmin@example.com',
      name: 'Builder Admin',
    });
  });

  it('is terminal: the borrowed view never carries view_as (no chaining)', async () => {
    const fx = builderAdminFixture();
    fx.builderSessions.set('builder-token', {
      email: 'builderadmin@example.com',
      tenantKey: 'north-homes',
      viewAs: { userId: 'user-member' },
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(resolveHeaders('builder-token'));
    expect(ctx!.permissions).not.toContain('view_as');
  });

  it('fails closed on an unknown target: empty permissions, no builder context, banner state intact', async () => {
    const fx = builderAdminFixture();
    fx.builderSessions.set('builder-token', {
      email: 'builderadmin@example.com',
      tenantKey: 'north-homes',
      viewAs: { userId: 'user-gone' },
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(resolveHeaders('builder-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.permissions).toEqual([]);
    expect(ctx!.builderId).toBeNull();
    expect(ctx!.viewAs).toEqual({ userId: 'user-gone' });
    expect(ctx!.realUser?.email).toBe('builderadmin@example.com');
  });

  it('fails closed on a disabled target', async () => {
    const fx = builderAdminFixture();
    fx.usersById.set('user-member', {
      ...(fx.usersById.get('user-member') as UserRecord),
      status: 'disabled',
    } as UserRecord);
    fx.builderSessions.set('builder-token', {
      email: 'builderadmin@example.com',
      tenantKey: 'north-homes',
      viewAs: { userId: 'user-member' },
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(resolveHeaders('builder-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.permissions).toEqual([]);
    expect(ctx!.builderId).toBeNull();
    expect(ctx!.realUser?.email).toBe('builderadmin@example.com');
  });

  it('a session without viewAs resolves normally with realUser null', async () => {
    const fx = builderAdminFixture();
    fx.builderSessions.set('builder-token', {
      email: 'builderadmin@example.com',
      tenantKey: 'north-homes',
      viewAs: null,
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(resolveHeaders('builder-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.viewAs).toBeNull();
    expect(ctx!.realUser).toBeNull();
    expect(ctx!.permissions).toContain('view_as');
  });

  it('fails closed when the target loses their session-org membership mid-session (never re-scopes to another tenant)', async () => {
    const fx = builderAdminFixture();
    fx.buildersById.set('builder-9', {
      id: 'builder-9',
      displayName: 'Other Homes',
      status: 'active',
    });
    // The target was removed from the session org (builder-7) but still
    // belongs to builder-9. The old first-membership fallback would have
    // re-scoped this session to builder-9's portal — cross-tenant exposure.
    fx.membershipsByUser.set('user-member', [
      { builderId: 'builder-9', role: 'builder_member', createdAt: NOW },
    ] as BuilderMembership[]);
    fx.builderSessions.set('builder-token', {
      email: 'builderadmin@example.com',
      tenantKey: 'north-homes',
      viewAs: { userId: 'user-member' },
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(resolveHeaders('builder-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.permissions).toEqual([]);
    expect(ctx!.builderId).toBeNull();
    expect(ctx!.builderName).toBeNull();
    // Banner state intact: the shell shows "target unavailable" + an exit,
    // and the real admin stays on realUser for the audit trail.
    expect(ctx!.viewAs).toEqual({ userId: 'user-member' });
    expect(ctx!.realUser?.email).toBe('builderadmin@example.com');
  });

  it('scopes the borrowed view to the session org when the target holds memberships in two orgs', async () => {
    const fx = builderAdminFixture();
    fx.buildersById.set('builder-9', {
      id: 'builder-9',
      displayName: 'Other Homes',
      status: 'active',
    });
    // Mid-session promotion in the OTHER org: the borrowed view in the
    // session org must not widen to the other org's role.
    fx.membershipsByUser.set('user-member', [
      { builderId: 'builder-7', role: 'builder_member', createdAt: NOW },
      { builderId: 'builder-9', role: 'builder_admin', createdAt: NOW },
    ] as BuilderMembership[]);
    fx.builderSessions.set('builder-token', {
      email: 'builderadmin@example.com',
      tenantKey: 'north-homes',
      viewAs: { userId: 'user-member' },
      builderId: 'builder-7',
    });
    const ctx = await fx.service.resolve(resolveHeaders('builder-token'));
    expect(ctx).not.toBeNull();
    expect(ctx!.builderId).toBe('builder-7');
    expect(ctx!.builderName).toBe('North Homes');
    // Permissions come from the session-org role only — the union across
    // orgs would have granted builder_admin permissions here.
    expect(ctx!.permissions).toEqual(
      effectivePermissions(null, ['builder_member']).filter(
        (p) => p !== 'view_as',
      ),
    );
    expect(ctx!.memberships).toEqual([
      { builderId: 'builder-7', role: 'builder_member', createdAt: NOW },
    ]);
    expect(ctx!.viewAs).toEqual({ userId: 'user-member' });
    expect(ctx!.realUser?.email).toBe('builderadmin@example.com');
  });
});

describe('sign-in time for the re-auth window (#730)', () => {
  it('an admin context carries the session created_at as authenticatedAt', async () => {
    const fx = makeService();
    seedAdmin(fx);
    const signedIn = new Date(NOW.getTime() - 45 * 60_000);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { createdAt: signedIn }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx!.authenticatedAt).toEqual(signedIn);
  });

  it('a view-as context keeps the REAL session sign-in time', async () => {
    const fx = makeService();
    seedAdmin(fx);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { viewAs: { builderId: 'builder-1' } }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx!.viewAs).toEqual({ builderId: 'builder-1' });
    expect(ctx!.authenticatedAt).toEqual(NOW);
  });

  it('a builder context carries the builder session created_at', async () => {
    const fx = makeService();
    fx.buildersById.set('builder-7', {
      id: 'builder-7',
      displayName: 'North Homes',
      status: 'active',
    });
    const signedIn = new Date(NOW.getTime() - 5 * 60_000);
    fx.builderSessions.set('builder-token', {
      email: 'portal@example.com',
      tenantKey: 'north-homes',
      viewAs: null,
      builderId: 'builder-7',
      createdAt: signedIn,
    });
    const ctx = await fx.service.resolve(BUILDER_HEADERS('builder-token'));
    expect(ctx!.authenticatedAt).toEqual(signedIn);
  });
});

describe('builder permissions follow the ACTIVE org role only (#855)', () => {
  /** Builder-only user: builder_admin of A, builder_member of B. */
  function seedTwoOrgUser(fx: Fixture, activeBuilderId: string | null): void {
    const u = user({
      id: 'user-two-orgs',
      email: 'two@example.com',
      name: 'Two Orgs',
      staffRole: null,
    });
    fx.usersByEmail.set(u.email, u);
    fx.usersById.set(u.id, u);
    fx.buildersById.set('builder-a', {
      id: 'builder-a',
      displayName: 'Org A',
      status: 'active',
    });
    fx.buildersById.set('builder-b', {
      id: 'builder-b',
      displayName: 'Org B',
      status: 'active',
    });
    fx.membershipsByUser.set(u.id, [
      { builderId: 'builder-a', role: 'builder_admin', createdAt: NOW },
      { builderId: 'builder-b', role: 'builder_member', createdAt: NOW },
    ]);
    fx.adminSessions.set(
      hashSessionToken('two-token'),
      adminSession('two-token', {
        email: u.email,
        userId: u.id,
        activeBuilderId,
      }),
    );
  }

  it('admin in A, member in B, active in B: only builder_member permissions', async () => {
    const fx = makeService();
    seedTwoOrgUser(fx, 'builder-b');
    const ctx = await fx.service.resolve(HEADERS('two-token'));
    expect(ctx!.builderId).toBe('builder-b');
    expect(new Set(ctx!.permissions)).toEqual(
      new Set(effectivePermissions(null, ['builder_member'])),
    );
    expect(ctx!.permissions).not.toContain('builder:users:manage');
    expect(ctx!.permissions).not.toContain('builder:billing');
    expect(ctx!.permissions).not.toContain('view_as');
    // The org switcher still sees every membership.
    expect(ctx!.memberships).toHaveLength(2);
  });

  it('the same user active in A gets the builder_admin permissions', async () => {
    const fx = makeService();
    seedTwoOrgUser(fx, 'builder-a');
    const ctx = await fx.service.resolve(HEADERS('two-token'));
    expect(ctx!.builderId).toBe('builder-a');
    expect(new Set(ctx!.permissions)).toEqual(
      new Set(effectivePermissions(null, ['builder_admin'])),
    );
  });

  it('no active org → no builder-role permissions', async () => {
    const fx = makeService();
    seedTwoOrgUser(fx, null);
    const ctx = await fx.service.resolve(HEADERS('two-token'));
    expect(ctx!.builderId).toBeNull();
    expect(ctx!.permissions).toEqual([]);
  });

  it('a dangling active org (membership removed) grants no builder-role permissions', async () => {
    const fx = makeService();
    seedTwoOrgUser(fx, 'builder-gone');
    const ctx = await fx.service.resolve(HEADERS('two-token'));
    expect(ctx!.builderId).toBeNull();
    expect(ctx!.permissions).toEqual([]);
  });

  it('staff-role permissions still apply alongside the active org role', async () => {
    const fx = makeService();
    seedTwoOrgUser(fx, 'builder-b');
    const u = user({
      id: 'user-two-orgs',
      email: 'two@example.com',
      name: 'Two Orgs',
      staffRole: 'viewer',
    });
    fx.usersById.set(u.id, u);
    const ctx = await fx.service.resolve(HEADERS('two-token'));
    expect(new Set(ctx!.permissions)).toEqual(
      new Set(effectivePermissions('viewer', ['builder_member'])),
    );
  });

  it('the permission guard 403s builder:users:manage and builder:billing for the member-in-B session', async () => {
    const fx = makeService();
    seedTwoOrgUser(fx, 'builder-b');
    const guard = createPermissionGuard({ authContext: fx.service });
    for (const [permission, route] of [
      ['builder:users:manage', 'GET /api/v1/builder/users'],
      ['builder:users:manage', 'PATCH /api/v1/builder/users/{id}'],
      ['builder:billing', 'GET /api/v1/builder/billing/overview'],
    ] as const) {
      const err = await guard
        .requirePermission(permission, HEADERS('two-token'), route)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
    }
    // Lead access (the member role) still works in B.
    const ctx = await guard.requirePermission(
      'builder:leads:read',
      HEADERS('two-token'),
      'GET /api/v1/builder/leads',
    );
    expect(ctx.builderId).toBe('builder-b');
  });

  it('admin view-as of a user scopes builder permissions to the target’s resolved org', async () => {
    const fx = makeService();
    seedAdmin(fx);
    const target = user({
      id: 'user-target',
      email: 'target@example.com',
      name: 'Target',
      staffRole: null,
    });
    fx.usersById.set(target.id, target);
    fx.buildersById.set('builder-b', {
      id: 'builder-b',
      displayName: 'Org B',
      status: 'active',
    });
    // Member in the org the view resolves to (first membership), admin
    // elsewhere: the admin role must not widen the borrowed view.
    fx.membershipsByUser.set(target.id, [
      { builderId: 'builder-1', role: 'builder_member', createdAt: NOW },
      { builderId: 'builder-b', role: 'builder_admin', createdAt: NOW },
    ]);
    fx.adminSessions.set(
      hashSessionToken('admin-token'),
      adminSession('admin-token', { viewAs: { userId: target.id } }),
    );
    const ctx = await fx.service.resolve(HEADERS('admin-token'));
    expect(ctx!.builderId).toBe('builder-1');
    expect(new Set(ctx!.permissions)).toEqual(
      new Set(effectivePermissions(null, ['builder_member'])),
    );
  });
});
