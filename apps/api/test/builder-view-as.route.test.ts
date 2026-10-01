/**
 * Builder-side view-as route tests (2026-09-30, Karan).
 *
 * The route is thin: permission guard → zod body → service → contract
 * shape. Permission checks live in the service too (defense in depth);
 * here we assert the route wiring:
 * - POST requires `view_as` via the permission guard (403 otherwise).
 * - POST validates the body (400 on missing/invalid userId).
 * - POST returns the contract shape with the target display name.
 * - DELETE is session-only: getAuthContext, NOT requirePermission (the
 *   borrowed view strips `view_as`, so requiring it would lock the user
 *   in). 401 without a session.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createBuilderViewAsRoute,
  type BuilderViewAsRouteDeps,
} from '../src/routes/builder/view-as.route';
import type { UserService } from '../src/services/user.service';
import type { AuthContext } from '../src/services/auth-context.service';
import type { PermissionGuard } from '../src/middleware/permission-guard';
import type { BuilderViewAsService } from '../src/services/builder-view-as.service';
import { HttpError } from '../src/middleware/errors';

const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HEADERS = { cookie: 'feasly_builder_session=valid-test-session' };

function makeDeps() {
  const ctx = {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'admin@builder.com',
    name: 'Builder Admin',
    staffRole: null,
    permissions: ['view_as'],
    builderId: '11111111-1111-4111-8111-111111111111',
    builderName: 'Elite Craft Builders',
    memberships: [],
    viewAs: null,
    realUser: null,
  } as unknown as AuthContext;

  const viewAs = {
    activate: vi.fn(async () => ({ active: true as const })),
    exit: vi.fn(async () => ({ active: false as const })),
  } as unknown as BuilderViewAsService;

  const permissionGuard = {
    requirePermission: vi.fn(async () => ctx),
    getAuthContext: vi.fn(async () => ctx),
  } as unknown as PermissionGuard;

  const userService = {
    findById: vi.fn(async () => ({
      id: TARGET_ID,
      name: 'Team Member',
      email: 'member@example.com',
    })),
  } as unknown as Pick<UserService, 'findById'>;

  const deps = {
    viewAs,
    permissionGuard,
    userService,
  } as unknown as BuilderViewAsRouteDeps;

  return { deps, ctx, viewAs, permissionGuard, userService };
}

describe('builder view-as route', () => {
  let d: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    d = makeDeps();
  });

  it('POST activates with the contract shape and target display name', async () => {
    const route = createBuilderViewAsRoute(d.deps);
    const res = await route.activate(HEADERS, { userId: TARGET_ID });
    expect(res).toEqual({
      active: true,
      target: { kind: 'user', id: TARGET_ID, displayName: 'Team Member' },
    });
    expect(d.permissionGuard.requirePermission).toHaveBeenCalledWith(
      'view_as',
      HEADERS,
      'POST /api/v1/builder/view-as',
    );
    expect(d.viewAs.activate).toHaveBeenCalledWith(
      'valid-test-session',
      TARGET_ID,
      d.ctx,
    );
  });

  it('POST 400s on a missing userId', async () => {
    const route = createBuilderViewAsRoute(d.deps);
    const err = await route
      .activate(HEADERS, {})
      .then(
        () => null,
        (e) => e as HttpError,
      );
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(400);
  });

  it('POST 400s on a non-uuid userId', async () => {
    const route = createBuilderViewAsRoute(d.deps);
    const err = await route
      .activate(HEADERS, { userId: 'not-a-uuid' })
      .then(
        () => null,
        (e) => e as HttpError,
      );
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(400);
  });

  it('POST denies without the view_as permission (guard throws 403)', async () => {
    const guard = d.permissionGuard as unknown as {
      requirePermission: ReturnType<typeof vi.fn>;
    };
    guard.requirePermission.mockRejectedValueOnce(
      new HttpError(403, 'FORBIDDEN', 'No access.', false),
    );
    const route = createBuilderViewAsRoute(d.deps);
    const err = await route
      .activate(HEADERS, { userId: TARGET_ID })
      .then(
        () => null,
        (e) => e as HttpError,
      );
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(403);
  });

  it('DELETE exits via getAuthContext (session-only, not requirePermission)', async () => {
    const route = createBuilderViewAsRoute(d.deps);
    const res = await route.exit(HEADERS);
    expect(res).toEqual({ active: false });
    expect(d.permissionGuard.getAuthContext).toHaveBeenCalledWith(HEADERS);
    expect(d.viewAs.exit).toHaveBeenCalledWith('valid-test-session', d.ctx);
  });

  it('DELETE 401s without a session', async () => {
    const guard = d.permissionGuard as unknown as {
      getAuthContext: ReturnType<typeof vi.fn>;
    };
    guard.getAuthContext.mockResolvedValueOnce(null);
    const route = createBuilderViewAsRoute(d.deps);
    const err = await route
      .exit(HEADERS)
      .then(
        () => null,
        (e) => e as HttpError,
      );
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(401);
  });

  it('DELETE 401s without a session token', async () => {
    const route = createBuilderViewAsRoute(d.deps);
    const err = await route
      .exit({})
      .then(
        () => null,
        (e) => e as HttpError,
      );
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(401);
  });
});
