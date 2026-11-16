/**
 * Builder Settings route tests (#870).
 *
 * Uses the REAL permission guard + role map with a fake auth-context, so
 * "owner can, member can't" is proven against ROLE_PERMISSIONS and the
 * registry — not a stub that always says yes.
 * - 401 unauthenticated on every endpoint
 * - members read profile/embed (canEdit false) but get 403 on PUT profile
 *   and POST origin-requests — both from the route and from the registry
 *   enforcement the dispatcher runs first
 * - owners write; the org always comes from the session
 * - writes are refused while viewing as a teammate
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuilderSettingsRoute } from '../src/routes/builder/settings.route';
import type { BuilderSettingsService } from '../src/services/builder-settings.service';
import { createPermissionGuard } from '../src/middleware/permission-guard';
import { enforceRoutePermissions } from '../src/middleware/enforce-route-permissions';
import { effectivePermissions } from '../src/auth/permissions';
import type {
  AuthContext,
  AuthContextService,
} from '../src/services/auth-context.service';
import type { BuilderRole } from '../src/services/user.service';
import { HttpError } from '../src/middleware/errors';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const HEADERS = { cookie: 'feasly_builder_session=test' };

function ctxFor(role: BuilderRole, overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: `${role}@builder.example`,
    name: role,
    staffRole: null,
    permissions: effectivePermissions(null, [role]),
    builderId: BUILDER_ID,
    builderName: 'Builder A',
    memberships: [{ builderId: BUILDER_ID, role, createdAt: new Date('2026-01-01T00:00:00Z') }],
    viewAs: null,
    realUser: null,
    ...overrides,
  } as unknown as AuthContext;
}

function setup(ctx: AuthContext | null) {
  const authContext = {
    resolve: vi.fn(async () => ctx),
    auditDenied: vi.fn(async () => undefined),
  } as unknown as AuthContextService;
  const permissionGuard = createPermissionGuard({ authContext });
  const settings = {
    getProfile: vi.fn(async (actor) => ({ actor })),
    updateProfile: vi.fn(async (actor, body) => ({ actor, body })),
    getEmbed: vi.fn(async (actor) => ({ actor })),
    requestOriginChange: vi.fn(async (actor, body) => ({ actor, body })),
    resolveSatisfiedOriginRequests: vi.fn(),
  } as unknown as BuilderSettingsService & Record<string, ReturnType<typeof vi.fn>>;
  const route = createBuilderSettingsRoute({ settings, permissionGuard });
  return { route, settings, permissionGuard, authContext };
}

async function status(p: Promise<unknown>): Promise<number> {
  const e = await p.then(() => null, (err: unknown) => err);
  return e instanceof HttpError ? e.status : 200;
}

describe('builder settings route', () => {
  describe('unauthenticated', () => {
    let s: ReturnType<typeof setup>;
    beforeEach(() => {
      s = setup(null);
    });
    it('401s every endpoint', async () => {
      expect(await status(s.route.getProfile({}))).toBe(401);
      expect(await status(s.route.updateProfile({}, {}))).toBe(401);
      expect(await status(s.route.getEmbed({}))).toBe(401);
      expect(await status(s.route.requestOriginChange({}, {}))).toBe(401);
    });
  });

  describe('builder_member', () => {
    it('reads profile and embed with canEdit false', async () => {
      const s = setup(ctxFor('builder_member'));
      await s.route.getProfile(HEADERS);
      await s.route.getEmbed(HEADERS);
      expect(s.settings.getProfile).toHaveBeenCalledWith(
        expect.objectContaining({ builderId: BUILDER_ID, canEdit: false }),
      );
      expect(s.settings.getEmbed).toHaveBeenCalledWith(
        expect.objectContaining({ builderId: BUILDER_ID, canEdit: false }),
      );
    });

    it('gets 403 on profile update and origin requests (route + registry)', async () => {
      const s = setup(ctxFor('builder_member'));
      expect(await status(s.route.updateProfile(HEADERS, { displayName: 'X' }))).toBe(403);
      expect(await status(s.route.requestOriginChange(HEADERS, { add: ['https://a.example'] }))).toBe(403);
      expect(s.settings.updateProfile).not.toHaveBeenCalled();
      expect(s.settings.requestOriginChange).not.toHaveBeenCalled();
      // The dispatcher enforces the registry before the route runs.
      expect(
        await status(enforceRoutePermissions(s.permissionGuard, 'PUT', '/api/v1/builder/profile', HEADERS)),
      ).toBe(403);
      expect(
        await status(
          enforceRoutePermissions(s.permissionGuard, 'POST', '/api/v1/builder/embed/origin-requests', HEADERS),
        ),
      ).toBe(403);
      // Reads pass the registry.
      expect(
        await status(enforceRoutePermissions(s.permissionGuard, 'GET', '/api/v1/builder/profile', HEADERS)),
      ).toBe(200);
      expect(
        await status(enforceRoutePermissions(s.permissionGuard, 'GET', '/api/v1/builder/embed', HEADERS)),
      ).toBe(200);
      expect(s.authContext.auditDenied).toHaveBeenCalled();
    });
  });

  describe('builder_admin (owner)', () => {
    it('updates the profile and files origin requests for the session org', async () => {
      const s = setup(ctxFor('builder_admin'));
      expect(
        await status(enforceRoutePermissions(s.permissionGuard, 'PUT', '/api/v1/builder/profile', HEADERS)),
      ).toBe(200);
      await s.route.updateProfile(HEADERS, { displayName: 'New name' });
      await s.route.requestOriginChange(HEADERS, { add: ['https://a.example'] });
      const actor = expect.objectContaining({
        builderId: BUILDER_ID,
        email: 'builder_admin@builder.example',
        canEdit: true,
      });
      expect(s.settings.updateProfile).toHaveBeenCalledWith(actor, { displayName: 'New name' });
      expect(s.settings.requestOriginChange).toHaveBeenCalledWith(actor, {
        add: ['https://a.example'],
      });
      await s.route.getProfile(HEADERS);
      expect(s.settings.getProfile).toHaveBeenCalledWith(actor);
    });

    it('refuses writes while viewing as a teammate (canEdit false on reads)', async () => {
      const s = setup(ctxFor('builder_admin', { viewAs: { targetUserId: 'x' } as never }));
      expect(await status(s.route.updateProfile(HEADERS, { displayName: 'X' }))).toBe(403);
      expect(await status(s.route.requestOriginChange(HEADERS, { add: ['https://a.example'] }))).toBe(403);
      await s.route.getProfile(HEADERS);
      expect(s.settings.getProfile).toHaveBeenCalledWith(expect.objectContaining({ canEdit: false }));
    });
  });

  it('403s a signed-in user with no builder org', async () => {
    const s = setup(ctxFor('builder_admin', { builderId: null, memberships: [] }));
    expect(await status(s.route.getEmbed(HEADERS))).toBe(403);
  });
});
