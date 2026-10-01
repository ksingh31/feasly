/**
 * Admin users route tests (auth/03).
 *
 * The route is thin: permission guard → tenant/role scoping → one
 * UserService method → contract shape. Guard semantics live in the service
 * (user.service.test.ts) and the permission matrix
 * (route-registry.conformance.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminUsersRoute,
  type AdminUsersRouteDeps,
} from '../src/routes/admin-users.route';
import type { UserService } from '../src/services/user.service';
import type { BuilderService } from '../src/services/builder.service';
import type { AuthContext } from '../src/services/auth-context.service';
import type { Permission } from '../src/auth/permissions';
import { HttpError } from '../src/middleware/errors';

const ADMIN_HEADERS = { cookie: 'feasly_admin_session=valid-test-session' };

function makeAuthContext(
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    userId: 'actor-1',
    email: 'admin@example.com',
    name: 'Admin',
    staffRole: 'admin',
    permissions: ['users:manage'],
    builderId: null,
    builderName: null,
    memberships: [],
    viewAs: null,
    realUser: null,
    ...overrides,
  } as AuthContext;
}

function makeDeps(expectedGatePerms: readonly Permission[]) {
  const ctx = makeAuthContext();
  const userService = {
    listUsers: vi.fn().mockResolvedValue([]),
    countUsers: vi.fn().mockResolvedValue(0),
    findById: vi.fn(),
    invite: vi.fn(),
    completeInvitation: vi.fn(),
    resendInvite: vi.fn(),
    revokeInvitation: vi.fn(),
    disableUser: vi.fn(),
    enableUser: vi.fn(),
    changeStaffRole: vi.fn(),
    renameUser: vi.fn(),
    setMemberships: vi.fn(),
    deleteUser: vi.fn(),
  } as unknown as UserService;
  const builders = {
    getBuilder: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', name: 'B1' }),
  } as unknown as BuilderService;
  const permissionGuard = {
    requirePermission: vi.fn(
      async (
        permissions: Permission | readonly Permission[],
        _headers: unknown,
        _route: string,
      ): Promise<AuthContext> => {
        expect([...(Array.isArray(permissions) ? permissions : [permissions])]).toEqual(
          [...expectedGatePerms],
        );
        return ctx;
      },
    ),
    requirePermissions: vi.fn(),
    getAuthContext: vi.fn(),
    requireBuilderId: vi.fn(),
  };
  const deps = { userService, permissionGuard, builders } as unknown as AdminUsersRouteDeps;
  return { deps, ctx, userService, builders, permissionGuard };
}

const STAFF_GATE = ['users:manage'] as const;
const INVITE_GATE = ['users:manage', 'builder:users:manage'] as const;

/** Deps where the guard resolves a builder-admin context (no staff role). */
function makeBuilderAdminDeps(gatePerms: readonly Permission[]) {
  const bundle = makeDeps(gatePerms);
  const builderCtx = makeAuthContext({
    staffRole: null,
    permissions: ['builder:users:manage'],
    memberships: [
      {
        builderId: '11111111-1111-4111-8111-111111111111',
        role: 'builder_admin',
        createdAt: new Date(),
      },
    ],
  });
  bundle.permissionGuard.requirePermission.mockImplementation(
    async (permissions: Permission | readonly Permission[]) => {
      const requested = Array.isArray(permissions) ? permissions : [permissions];
      expect([...requested]).toEqual([...gatePerms]);
      // Honest guard: the builder ctx only carries builder:users:manage, so
      // staff-only gates reject here exactly like the real guard would.
      const satisfied = requested.some((perm) =>
        builderCtx.permissions.includes(perm),
      );
      if (!satisfied) {
        throw new HttpError(403, 'FORBIDDEN', 'Forbidden', false);
      }
      return builderCtx;
    },
  );
  return bundle;
}

describe('admin-users route (auth/03)', () => {
  it('list: passes pagination through and strips Entra ids', async () => {
    const { deps, userService } = makeDeps(INVITE_GATE);
    const route = createAdminUsersRoute(deps);
    const row = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      email: 'a@example.com',
      name: 'A',
      staffRole: 'viewer',
      memberships: [],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      entraObjectId: 'secret', // server-only field must be stripped
    };
    vi.mocked(userService.listUsers).mockResolvedValue([row] as never);
    vi.mocked(userService.countUsers).mockResolvedValue(1);

    const result = await route.list(ADMIN_HEADERS, { limit: 10, offset: 5 });
    expect(result.total).toBe(1);
    expect(result.users[0]).not.toHaveProperty('entraObjectId');
    expect(userService.listUsers).toHaveBeenCalledWith(10, 5, undefined);
    expect(userService.countUsers).toHaveBeenCalledWith(undefined);
  });

  it('list: builder admin only sees users in their own orgs', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    const route = createAdminUsersRoute(deps);
    await route.list(ADMIN_HEADERS, {});
    expect(userService.listUsers).toHaveBeenCalledWith(
      50,
      0,
      { builderIds: ['11111111-1111-4111-8111-111111111111'] },
    );
    expect(userService.countUsers).toHaveBeenCalledWith({
      builderIds: ['11111111-1111-4111-8111-111111111111'],
    });
  });

  it('get: builder admin cannot read users outside their orgs (403)', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    vi.mocked(userService.findById).mockResolvedValue({
      id: '223e4567-e89b-12d3-a456-426614174000',
      email: 'x@example.com',
      name: 'X',
      staffRole: 'viewer',
      memberships: [
        {
          builderId: 'builder-2',
          role: 'builder_member',
          createdAt: new Date(),
        },
      ],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const route = createAdminUsersRoute(deps);
    await expect(route.get(ADMIN_HEADERS, '223e4567-e89b-12d3-a456-426614174000')).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('invite: staff admin invites without builderId', async () => {
    const { deps, userService } = makeDeps(INVITE_GATE);
    vi.mocked(userService.invite).mockResolvedValue({
      user: {
        id: '323e4567-e89b-12d3-a456-426614174000',
        email: 'n@example.com',
        name: 'New',
        staffRole: 'viewer',
        memberships: [],
        status: 'invited',
        isProtected: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      emailSent: true,
    } as never);
    const route = createAdminUsersRoute(deps);
    const result = await route.invite(ADMIN_HEADERS, {
      email: 'n@example.com',
      name: 'New',
      role: 'viewer',
    });
    expect(result.emailSent).toBe(true);
    expect(userService.invite).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'n@example.com', builderId: null }),
    );
  });

  it('invite: builder admin must supply builderId, and only from their own orgs', async () => {
    const { deps, userService, builders } = makeBuilderAdminDeps(INVITE_GATE);
    vi.mocked(userService.invite).mockResolvedValue({
      user: {
        id: '423e4567-e89b-12d3-a456-426614174000',
        email: 'b@example.com',
        name: 'B',
        staffRole: null,
        memberships: [],
        status: 'invited',
        isProtected: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      emailSent: true,
    } as never);
    const route = createAdminUsersRoute(deps);

    // No builderId at all → schema rejects (403 from the route guard).
    await expect(
      route.invite(ADMIN_HEADERS, {
        email: 'b@example.com',
        name: 'B',
        role: 'builder_admin',
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));

    // Forged builder id (another org) → 403 before the service is touched.
    await expect(
      route.invite(ADMIN_HEADERS, {
        email: 'b@example.com',
        name: 'B',
        role: 'builder_admin',
        builderId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
    expect(userService.invite).not.toHaveBeenCalled();

    // Own org works.
    const ok = await route.invite(ADMIN_HEADERS, {
      email: 'b@example.com',
      name: 'B',
      role: 'builder_admin',
      builderId: '11111111-1111-4111-8111-111111111111',
    });
    expect(ok.emailSent).toBe(true);
    expect(userService.invite).toHaveBeenCalledWith(
      expect.objectContaining({
        builderId: '11111111-1111-4111-8111-111111111111',
        role: 'builder_admin',
      }),
    );
  });

  it('invite: builder admin cannot grant staff roles', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    const route = createAdminUsersRoute(deps);
    await expect(
      route.invite(ADMIN_HEADERS, {
        email: 's@example.com',
        name: 'S',
        role: 'admin',
        builderId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
    expect(userService.invite).not.toHaveBeenCalled();
  });

  it('update: builder admin can patch name of a non-staff member but not role, and never rename staff accounts', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    vi.mocked(userService.findById).mockResolvedValue({
      id: '523e4567-e89b-12d3-a456-426614174000',
      email: 'm@example.com',
      name: 'M',
      staffRole: null,
      memberships: [
        {
          builderId: '11111111-1111-4111-8111-111111111111',
          role: 'builder_member',
          createdAt: new Date(),
        },
      ],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(userService.renameUser).mockResolvedValue({
      id: '523e4567-e89b-12d3-a456-426614174000',
      email: 'm@example.com',
      name: 'Renamed',
      staffRole: null,
      memberships: [],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const route = createAdminUsersRoute(deps);

    await route.update(ADMIN_HEADERS, '523e4567-e89b-12d3-a456-426614174000', { name: 'Renamed' });
    expect(userService.renameUser).toHaveBeenCalledWith(
      '523e4567-e89b-12d3-a456-426614174000',
      'Renamed',
      expect.anything(),
    );

    // Builder admins cannot touch staff roles — the contract field is staffRole.
    await expect(
      route.update(ADMIN_HEADERS, '523e4567-e89b-12d3-a456-426614174000', {
        staffRole: 'admin',
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
    expect(userService.changeStaffRole).not.toHaveBeenCalled();
  });

  it('update: builder admin cannot rename a staff account (403)', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    vi.mocked(userService.findById).mockResolvedValue({
      id: '523e4567-e89b-12d3-a456-426614174000',
      email: 'staff@example.com',
      name: 'Staff',
      staffRole: 'viewer',
      memberships: [
        {
          builderId: '11111111-1111-4111-8111-111111111111',
          role: 'builder_member',
          createdAt: new Date(),
        },
      ],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const route = createAdminUsersRoute(deps);
    await expect(
      route.update(ADMIN_HEADERS, '523e4567-e89b-12d3-a456-426614174000', {
        name: 'Renamed by builder',
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        status: 403,
        message: 'Staff accounts can only be renamed by Feasly staff.',
      }),
    );
    expect(userService.renameUser).not.toHaveBeenCalled();
  });

  it('update: builder admin cannot disable a staff account (403)', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    vi.mocked(userService.findById).mockResolvedValue({
      id: '523e4567-e89b-12d3-a456-426614174000',
      email: 'staff@example.com',
      name: 'Staff',
      staffRole: 'viewer',
      memberships: [
        {
          builderId: '11111111-1111-4111-8111-111111111111',
          role: 'builder_member',
          createdAt: new Date(),
        },
      ],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const route = createAdminUsersRoute(deps);
    await expect(
      route.update(ADMIN_HEADERS, '523e4567-e89b-12d3-a456-426614174000', {
        status: 'disabled',
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        status: 403,
        message: 'You can only deactivate members who belong solely to your organization.',
      }),
    );
    expect(userService.disableUser).not.toHaveBeenCalled();
  });

  it('update: builder admin cannot disable a user with memberships in other orgs (403)', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    vi.mocked(userService.findById).mockResolvedValue({
      id: '523e4567-e89b-12d3-a456-426614174000',
      email: 'm@example.com',
      name: 'M',
      staffRole: null,
      memberships: [
        {
          builderId: '11111111-1111-4111-8111-111111111111',
          role: 'builder_member',
          createdAt: new Date(),
        },
        {
          builderId: '22222222-2222-4222-8222-222222222222',
          role: 'builder_member',
          createdAt: new Date(),
        },
      ],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const route = createAdminUsersRoute(deps);
    await expect(
      route.update(ADMIN_HEADERS, '523e4567-e89b-12d3-a456-426614174000', {
        status: 'disabled',
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
    expect(userService.disableUser).not.toHaveBeenCalled();
  });

  it('update: builder admin cannot reactivate a staff account (403)', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    vi.mocked(userService.findById).mockResolvedValue({
      id: '523e4567-e89b-12d3-a456-426614174000',
      email: 'staff@example.com',
      name: 'Staff',
      staffRole: 'admin',
      memberships: [
        {
          builderId: '11111111-1111-4111-8111-111111111111',
          role: 'builder_member',
          createdAt: new Date(),
        },
      ],
      status: 'disabled',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const route = createAdminUsersRoute(deps);
    await expect(
      route.update(ADMIN_HEADERS, '523e4567-e89b-12d3-a456-426614174000', {
        status: 'active',
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        status: 403,
        message: 'You can only reactivate members who belong solely to your organization.',
      }),
    );
    expect(userService.enableUser).not.toHaveBeenCalled();
  });

  it('update: builder admin can disable a sole-org member', async () => {
    const { deps, userService } = makeBuilderAdminDeps(INVITE_GATE);
    const target = {
      id: '523e4567-e89b-12d3-a456-426614174000',
      email: 'm@example.com',
      name: 'M',
      staffRole: null,
      memberships: [
        {
          builderId: '11111111-1111-4111-8111-111111111111',
          role: 'builder_member',
          createdAt: new Date(),
        },
      ],
      status: 'active',
      isProtected: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(userService.findById).mockResolvedValue(target as never);
    vi.mocked(userService.disableUser).mockResolvedValue({
      ...target,
      status: 'disabled',
    } as never);
    const route = createAdminUsersRoute(deps);
    const result = await route.update(
      ADMIN_HEADERS,
      '523e4567-e89b-12d3-a456-426614174000',
      { status: 'disabled' },
    );
    expect(userService.disableUser).toHaveBeenCalledWith(
      '523e4567-e89b-12d3-a456-426614174000',
      expect.anything(),
    );
    expect(result.status).toBe('disabled');
  });

  it('remove: builder admin cannot delete even org users (staff-only)', async () => {
    const { deps, userService } = makeBuilderAdminDeps(STAFF_GATE);
    const route = createAdminUsersRoute(deps);
    await expect(route.remove(ADMIN_HEADERS, '523e4567-e89b-12d3-a456-426614174000')).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(userService.deleteUser).not.toHaveBeenCalled();
  });

  it('remove: staff delete calls the service with audit identity', async () => {
    const { deps, userService } = makeDeps(STAFF_GATE);
    vi.mocked(userService.deleteUser).mockResolvedValue({} as never);
    const route = createAdminUsersRoute(deps);
    const result = await route.remove(ADMIN_HEADERS, '623e4567-e89b-12d3-a456-426614174000');
    expect(result).toEqual({ deleted: true });
    expect(userService.deleteUser).toHaveBeenCalledWith(
      '623e4567-e89b-12d3-a456-426614174000',
      expect.objectContaining({
        actorEmail: 'admin@example.com',
        actorId: 'actor-1',
      }),
    );
  });

  it('resendInvite: passes through with the audit identity', async () => {
    const { deps, userService } = makeDeps(INVITE_GATE);
    vi.mocked(userService.findById).mockResolvedValue({
      id: '723e4567-e89b-12d3-a456-426614174000',
      email: 'r@example.com',
    } as never);
    vi.mocked(userService.resendInvite).mockResolvedValue({
      user: {
        id: '723e4567-e89b-12d3-a456-426614174000',
        email: 'r@example.com',
        name: 'R',
        staffRole: 'viewer',
        memberships: [],
        status: 'invited',
        isProtected: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      emailSent: true,
    } as never);
    const route = createAdminUsersRoute(deps);
    const result = await route.resendInvite(ADMIN_HEADERS, '723e4567-e89b-12d3-a456-426614174000');
    expect(result.emailSent).toBe(true);
    expect(userService.resendInvite).toHaveBeenCalledWith(
      'r@example.com',
      expect.objectContaining({ actorEmail: 'admin@example.com' }),
    );
  });

  it('validation: bad UUID and bad email are rejected before the service', async () => {
    const { deps, userService } = makeDeps(INVITE_GATE);
    const route = createAdminUsersRoute(deps);
    await expect(route.get(ADMIN_HEADERS, 'not-a-uuid')).rejects.toThrow(
      expect.objectContaining({ status: 400 }),
    );
    const inviteDeps = makeDeps(INVITE_GATE);
    const inviteRoute = createAdminUsersRoute(inviteDeps.deps);
    await expect(
      inviteRoute.invite(ADMIN_HEADERS, {
        email: 'not-an-email',
        name: 'X',
        role: 'viewer',
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 400 }));
    expect(userService.findById).not.toHaveBeenCalled();
    expect(
      (inviteDeps.userService as unknown as { invite: ReturnType<typeof vi.fn> })
        .invite,
    ).not.toHaveBeenCalled();
  });
});
