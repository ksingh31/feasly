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
// Builder sessions ride the httpOnly builder cookie (never the Bearer header).
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
    expect(ctx!.permissions).toEqual(
      expect.arrayContaining(effectivePermissions(null, ['builder_admin'])),
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

  it('unknown builder on the session denies the session', async () => {
    const fx = makeService();
    fx.builderSessions.set('builder-token', {
      email: 'portal@example.com',
      tenantKey: 'ghost',
      builderId: 'builder-ghost',
    });
    await expect(
      fx.service.resolve(BUILDER_HEADERS('builder-token')),
    ).resolves.toBeNull();
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
