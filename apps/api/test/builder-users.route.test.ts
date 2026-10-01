/**
 * Builder org user-management route tests (auth/05).
 *
 * The route is thin: permission guard → session builder id (never request
 * params) → one UserService method → contract shape.
 * - list is org-scoped via the session's active builder
 * - invite forces builder roles and takes the builder id from the session
 * - update/remove require the target to hold a membership in the active org
 * - deactivating/reactivating additionally requires the target to belong
 *   solely to the caller's org with no staff role (global lifecycle is
 *   Feasly-staff-only)
 * - disabling / removing kills the user's builder sessions immediately
 * - callers cannot change or remove their own membership
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createBuilderUsersRoute,
  type BuilderUsersRouteDeps,
} from '../src/routes/builder/users.route';
import type { UserService, PublicUser } from '../src/services/user.service';
import type { AuthContext } from '../src/services/auth-context.service';
import type { PermissionGuard } from '../src/middleware/permission-guard';
import type { BuilderSessionStore } from '../src/services/builder-auth.service';
import { HttpError } from '../src/middleware/errors';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HEADERS = { cookie: 'feasly_builder_session=valid-test-session' };

function publicUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: TARGET_ID,
    email: 'member@example.com',
    name: 'Member',
    status: 'active',
    staffRole: null,
    isProtected: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    memberships: [{ builderId: BUILDER_ID, role: 'builder_member', createdAt: new Date('2026-01-01T00:00:00Z') }],
    ...overrides,
  } as PublicUser;
}

function makeDeps() {
  const ctx = {
    userId: ACTOR_ID,
    email: 'admin@builder.com',
    name: 'Builder Admin',
    staffRole: null,
    permissions: ['builder:users:manage'],
    builderId: BUILDER_ID,
    builderName: 'Elite Craft Builders',
    memberships: [{ builderId: BUILDER_ID, role: 'builder_admin', createdAt: new Date('2026-01-01T00:00:00Z') }],
    viewAs: null,
    realUser: null,
  } as unknown as AuthContext;

  const userService = {
    listUsers: vi.fn(async () => [publicUser()]),
    findById: vi.fn(async () => publicUser()),
    invite: vi.fn(async () => ({
      user: publicUser({ email: 'new@example.com' }),
      emailSent: true,
    })),
    setMemberships: vi.fn(async (_id: string, ms: unknown) => publicUser()),
    renameUser: vi.fn(async (_id: string, name: string) => publicUser({ name })),
    disableUser: vi.fn(async () => publicUser({ status: 'disabled' })),
    enableUser: vi.fn(async () => publicUser({ status: 'active' })),
  } as unknown as UserService;

  const permissionGuard = {
    requirePermission: vi.fn(async () => ctx),
    requireBuilderId: vi.fn(async () => BUILDER_ID),
    getAuthContext: vi.fn(),
    requirePermissions: vi.fn(),
  } as unknown as PermissionGuard;

  const builderSessions = {
    revokeByUserId: vi.fn(async () => 2),
  } as unknown as BuilderSessionStore;

  const deps = {
    userService,
    permissionGuard,
    authContext: {},
    builderSessions,
  } as unknown as BuilderUsersRouteDeps;

  return { deps, ctx, userService, permissionGuard, builderSessions };
}

describe('builder users route', () => {
  let d: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    d = makeDeps();
  });

  it('lists users scoped to the session builder id', async () => {
    const route = createBuilderUsersRoute(d.deps);
    const result = await route.list(HEADERS);
    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.role).toBe('builder_member');
    expect(d.userService.listUsers).toHaveBeenCalledWith(100, 0, {
      builderIds: [BUILDER_ID],
    });
    expect(d.permissionGuard.requirePermission).toHaveBeenCalledWith(
      'builder:users:manage',
      HEADERS,
      'GET /api/v1/builder/users',
    );
  });

  it('invite forces builder roles and the session builder id', async () => {
    const route = createBuilderUsersRoute(d.deps);
    const result = await route.invite(HEADERS, {
      email: 'new@example.com',
      name: 'New Member',
      role: 'builder_admin',
      builderId: 'ignored-client-supplied-id',
    });
    expect(result.user.email).toBe('new@example.com');
    const inviteArg = vi.mocked(d.userService.invite).mock.calls[0]?.[0];
    expect(inviteArg).toMatchObject({
      email: 'new@example.com',
      role: 'builder_admin',
      builderId: BUILDER_ID,
    });
    // The client-supplied builder id is never used.
    expect(inviteArg?.builderId).not.toBe('ignored-client-supplied-id');
  });

  it('invite rejects non-builder roles', async () => {
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .invite(HEADERS, {
        email: 'new@example.com',
        name: 'New Member',
        role: 'super_admin',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(d.userService.invite).not.toHaveBeenCalled();
  });

  it('update refuses to rename a staff account (403, staff-only rename)', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({ staffRole: 'admin' }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .update(HEADERS, TARGET_ID, { name: 'Renamed by builder' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toBe(
      'Staff accounts can only be renamed by Feasly staff.',
    );
    expect(d.userService.renameUser).not.toHaveBeenCalled();
  });

  it('update allows renaming a non-staff org member', async () => {
    const route = createBuilderUsersRoute(d.deps);
    const result = await route.update(HEADERS, TARGET_ID, { name: 'Renamed' });
    expect(result.name).toBe('Renamed');
    expect(d.userService.renameUser).toHaveBeenCalledWith(
      TARGET_ID,
      'Renamed',
      expect.objectContaining({ actorEmail: 'admin@builder.com' }),
    );
  });

  it('update refuses targets outside the active org', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({
        memberships: [
          { builderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'builder_member', createdAt: new Date('2026-01-01T00:00:00Z') },
        ],
      }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .update(HEADERS, TARGET_ID, { name: 'Hacker' })
      .catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
  });

  it('update refuses self-changes', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({ id: ACTOR_ID }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .update(HEADERS, ACTOR_ID, { role: 'builder_member' })
      .catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toContain('own membership');
  });

  it('disabling a user kills their builder sessions immediately', async () => {
    const route = createBuilderUsersRoute(d.deps);
    const result = await route.update(HEADERS, TARGET_ID, {
      status: 'disabled',
    });
    expect(result.status).toBe('disabled');
    expect(d.builderSessions.revokeByUserId).toHaveBeenCalledWith(
      TARGET_ID,
      expect.any(Date),
    );
  });

  it('deactivate refuses a user with a membership in another org', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({
        memberships: [
          { builderId: BUILDER_ID, role: 'builder_member', createdAt: new Date('2026-01-01T00:00:00Z') },
          { builderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'builder_member', createdAt: new Date('2026-01-01T00:00:00Z') },
        ],
      }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .update(HEADERS, TARGET_ID, { status: 'disabled' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toContain('solely');
    expect(d.userService.disableUser).not.toHaveBeenCalled();
    expect(d.builderSessions.revokeByUserId).not.toHaveBeenCalled();
  });

  it('deactivate refuses a user holding a staff role', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({ staffRole: 'viewer' }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .update(HEADERS, TARGET_ID, { status: 'disabled' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(d.userService.disableUser).not.toHaveBeenCalled();
  });

  it('reactivate refuses a user holding a staff role', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({ staffRole: 'admin', status: 'disabled' }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .update(HEADERS, TARGET_ID, { status: 'active' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(d.userService.enableUser).not.toHaveBeenCalled();
  });

  it('reactivate refuses a user with a membership in another org', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({
        status: 'disabled',
        memberships: [
          { builderId: BUILDER_ID, role: 'builder_member', createdAt: new Date('2026-01-01T00:00:00Z') },
          { builderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'builder_admin', createdAt: new Date('2026-01-01T00:00:00Z') },
        ],
      }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route
      .update(HEADERS, TARGET_ID, { status: 'active' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(d.userService.enableUser).not.toHaveBeenCalled();
  });

  it('reactivate allows a sole-org member', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({ status: 'disabled' }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const result = await route.update(HEADERS, TARGET_ID, {
      status: 'active',
    });
    expect(result.status).toBe('active');
    expect(d.userService.enableUser).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({ actorEmail: 'admin@builder.com' }),
    );
  });

  it('remove revokes the membership and kills sessions immediately', async () => {
    const route = createBuilderUsersRoute(d.deps);
    const result = await route.remove(HEADERS, TARGET_ID);
    expect(result.removed).toBe(true);
    expect(d.userService.setMemberships).toHaveBeenCalledWith(TARGET_ID, []);
    expect(d.builderSessions.revokeByUserId).toHaveBeenCalledWith(
      TARGET_ID,
      expect.any(Date),
    );
  });

  it('remove refuses self-removal', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(
      publicUser({ id: ACTOR_ID }),
    );
    const route = createBuilderUsersRoute(d.deps);
    const err = await route.remove(HEADERS, ACTOR_ID).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
  });
});
