/**
 * Builder partner routes (#888).
 *
 * - Public `GET /api/v1/partners` wraps the service's active list.
 * - Admin routes: 401 without a session, shape validation (400), id param
 *   validation, delegation to the service with the admin email.
 * - Central permission enforcement from the registry: viewer may read but
 *   not write; a builder session gets 403 on every admin partner route.
 *
 * Services are faked at the interface; no DB.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPartnersRoute } from '../src/routes/partners.route';
import { createAdminPartnersRoute } from '../src/routes/admin-partners.route';
import type { BuilderPartnersService } from '../src/services/builder-partners.service';
import type { AdminGuard } from '../src/middleware/admin-guard';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { enforceRoutePermissions } from '../src/middleware/enforce-route-permissions';
import {
  createPermissionGuard,
  type PermissionGuardDeps,
} from '../src/middleware/permission-guard';
import { effectivePermissions } from '../src/auth/permissions';
import type { AuthContext } from '../src/services/auth-context.service';
import type { BuilderRole, StaffRole } from '../src/services/user.service';

const VALID_SESSION = 'feasly_admin_session=valid-test-session';
const PARTNER_ID = '123e4567-e89b-12d3-a456-426614174000';

const PUBLIC_PARTNER = {
  id: PARTNER_ID,
  name: 'Elite Craft Builders',
  logoUrl: null,
  websiteUrl: 'https://elitecraftbuilders.com',
  description: null,
};
const ADMIN_PARTNER = {
  ...PUBLIC_PARTNER,
  builderId: null,
  displayOrder: 0,
  active: true,
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
};

function makeService() {
  return {
    listPublic: vi.fn(async () => [PUBLIC_PARTNER]),
    listAdmin: vi.fn(async () => [ADMIN_PARTNER]),
    create: vi.fn(async () => ADMIN_PARTNER),
    update: vi.fn(async () => ({ ...ADMIN_PARTNER, active: false })),
  } satisfies BuilderPartnersService;
}

const adminGuard = {
  async requireAdmin(headers: Record<string, string | string[] | undefined>) {
    if (headers['cookie'] !== VALID_SESSION) {
      throw new HttpError(401, ErrorCodes.UNAUTHENTICATED, 'Admin authentication required.', false);
    }
  },
  async getAdminEmail() {
    return 'admin@example.com';
  },
} as unknown as AdminGuard;

const headers = { cookie: VALID_SESSION };

describe('public partners route', () => {
  it('returns { partners } from the service', async () => {
    const partners = makeService();
    const route = createPartnersRoute({ partners });
    expect(await route.list()).toEqual({ partners: [PUBLIC_PARTNER] });
    expect(partners.listPublic).toHaveBeenCalledTimes(1);
  });
});

describe('admin partners route', () => {
  it('every endpoint requires an admin session (401)', async () => {
    const partners = makeService();
    const route = createAdminPartnersRoute({ partners, adminGuard });
    await expect(route.list({})).rejects.toMatchObject({ status: 401 });
    await expect(route.create({}, { name: 'X' })).rejects.toMatchObject({ status: 401 });
    await expect(route.update({}, PARTNER_ID, { active: false })).rejects.toMatchObject({
      status: 401,
    });
    expect(partners.create).not.toHaveBeenCalled();
    expect(partners.update).not.toHaveBeenCalled();
  });

  it('list returns every partner', async () => {
    const route = createAdminPartnersRoute({ partners: makeService(), adminGuard });
    expect(await route.list(headers)).toEqual({ partners: [ADMIN_PARTNER] });
  });

  it('create delegates with the admin email', async () => {
    const partners = makeService();
    const route = createAdminPartnersRoute({ partners, adminGuard });
    const body = { name: 'New', websiteUrl: 'https://new.example', displayOrder: 2 };
    await route.create(headers, body);
    expect(partners.create).toHaveBeenCalledWith(body, 'admin@example.com');
  });

  it('update (deactivate / reorder) delegates with the parsed id', async () => {
    const partners = makeService();
    const route = createAdminPartnersRoute({ partners, adminGuard });
    await route.update(headers, PARTNER_ID, { active: false, displayOrder: 3 });
    expect(partners.update).toHaveBeenCalledWith(
      PARTNER_ID,
      { active: false, displayOrder: 3 },
      'admin@example.com',
    );
  });

  it.each([
    ['missing name', { websiteUrl: 'https://x.example' }],
    ['non-string name', { name: 5 }],
    ['unknown field', { name: 'X', email: 'someone@example.com' }],
    ['non-boolean active', { name: 'X', active: 'yes' }],
    ['non-uuid builderId', { name: 'X', builderId: 'abc' }],
    ['not an object', 'nope'],
  ])('create rejects %s with 400', async (_why, body) => {
    const partners = makeService();
    const route = createAdminPartnersRoute({ partners, adminGuard });
    await expect(route.create(headers, body)).rejects.toMatchObject({
      status: 400,
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(partners.create).not.toHaveBeenCalled();
  });

  it('update rejects a bad id or body with 400', async () => {
    const partners = makeService();
    const route = createAdminPartnersRoute({ partners, adminGuard });
    await expect(route.update(headers, 'not-a-uuid', { active: false })).rejects.toMatchObject({
      status: 400,
    });
    await expect(route.update(headers, PARTNER_ID, { displayOrder: '1' })).rejects.toMatchObject({
      status: 400,
    });
    expect(partners.update).not.toHaveBeenCalled();
  });
});

describe('admin partners — central registry permissions', () => {
  const NOW = new Date('2026-11-16T12:00:00Z');
  function guardFor(staffRole: StaffRole | null, members: BuilderRole[]) {
    const ctx: AuthContext = {
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
      authenticatedAt: NOW,
    };
    const authContext = {
      resolve: async () => ctx,
      auditDenied: vi.fn(async () => {}),
      auditViewAsAction: vi.fn(async () => {}),
    };
    return createPermissionGuard({
      authContext: authContext as unknown as PermissionGuardDeps['authContext'],
      reauthWindowSeconds: 1_800,
      clock: () => NOW,
    });
  }
  const H = { authorization: 'Bearer <redacted>' };
  const LIST = '/api/v1/admin/partners';
  const DETAIL = '/api/v1/admin/partners/{id}';

  it('admin may read and write', async () => {
    const guard = guardFor('admin', []);
    await expect(enforceRoutePermissions(guard, 'GET', LIST, H)).resolves.not.toThrow();
    await expect(enforceRoutePermissions(guard, 'POST', LIST, H)).resolves.not.toThrow();
    await expect(enforceRoutePermissions(guard, 'PATCH', DETAIL, H)).resolves.not.toThrow();
  });

  it('viewer may read but gets 403 on add / update', async () => {
    const guard = guardFor('viewer', []);
    await expect(enforceRoutePermissions(guard, 'GET', LIST, H)).resolves.not.toThrow();
    await expect(enforceRoutePermissions(guard, 'POST', LIST, H)).rejects.toMatchObject({
      status: 403,
    });
    await expect(enforceRoutePermissions(guard, 'PATCH', DETAIL, H)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('a builder_admin session gets 403 on every admin partner route', async () => {
    const guard = guardFor(null, ['builder_admin']);
    for (const [method, path] of [
      ['GET', LIST],
      ['POST', LIST],
      ['PATCH', DETAIL],
    ] as const) {
      await expect(enforceRoutePermissions(guard, method, path, H)).rejects.toMatchObject({
        status: 403,
      });
    }
  });
});
