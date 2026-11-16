/**
 * #730 — re-auth for dangerous actions.
 *
 * AC4: "a dangerous action after the re-auth window prompts sign-in again."
 * Registry routes flagged `recentAuth` (view-as, mark-paid, user
 * deactivation, API-key issuance/rotation) need a sign-in no older than
 * SESSION_REAUTH_WINDOW_SECONDS; otherwise the central enforcement point
 * answers 401 REAUTH_REQUIRED (audit-logged) and the route never runs.
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { enforceRoutePermissions } from '../src/middleware/enforce-route-permissions';
import {
  createPermissionGuard,
  type PermissionGuardDeps,
} from '../src/middleware/permission-guard';
import { ROLE_PERMISSIONS } from '../src/auth/permissions';
import { ROUTE_REGISTRY } from '../src/registry/route-registry';
import type { AuthContext } from '../src/services/auth-context.service';

const NOW = new Date('2026-11-16T12:00:00Z');
const WINDOW_SECONDS = 1_800;
const HEADERS = { authorization: 'Bearer test-session' };

function superAdmin(authenticatedAt?: Date): AuthContext {
  return {
    userId: 'u-1',
    email: 'admin@example.com',
    name: 'Admin',
    staffRole: 'super_admin',
    permissions: ROLE_PERMISSIONS.super_admin,
    builderId: 'b-1',
    builderName: 'Builder',
    memberships: [],
    viewAs: null,
    realUser: null,
    ...(authenticatedAt ? { authenticatedAt } : {}),
  };
}

function harness(ctx: AuthContext, deps: Partial<PermissionGuardDeps> = {}) {
  const auditDenied = vi.fn(async (_args: unknown) => {});
  const authContext = {
    resolve: async () => ctx,
    auditDenied,
    auditViewAsAction: vi.fn(async () => {}),
  } as unknown as PermissionGuardDeps['authContext'];
  const guard = createPermissionGuard({
    authContext,
    reauthWindowSeconds: WINDOW_SECONDS,
    clock: () => NOW,
    ...deps,
  });
  return { guard, auditDenied };
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const DANGEROUS: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/v1/admin/view-as'],
  ['POST', '/api/v1/builder/view-as'],
  ['POST', '/api/v1/admin/billing/invoices/{id}/mark-paid'],
  ['PATCH', '/api/v1/admin/users/{id}'],
  ['PATCH', '/api/v1/builder/users/{id}'],
  ['DELETE', '/api/v1/builder/users/{id}'],
  ['POST', '/api/v1/admin/api-keys'],
  ['POST', '/api/v1/admin/api-keys/{id}/rotate'],
];

describe('re-auth window on dangerous actions (#730 AC4)', () => {
  for (const [method, path] of DANGEROUS) {
    it(`${method} ${path} is flagged recentAuth in the registry`, () => {
      const entry = ROUTE_REGISTRY.find((e) => e.method === method && e.path === path);
      expect(entry?.recentAuth).toBe(true);
    });

    it(`${method} ${path} after the window → 401 REAUTH_REQUIRED, audit-logged`, async () => {
      const { guard, auditDenied } = harness(superAdmin(minutesAgo(31)));
      const err = await enforceRoutePermissions(guard, method, path, HEADERS).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(401);
      expect((err as HttpError).code).toBe(ErrorCodes.REAUTH_REQUIRED);
      expect(auditDenied).toHaveBeenCalledWith(
        expect.objectContaining({ permission: 'recent-auth', route: `${method} ${path}` }),
      );
    });

    it(`${method} ${path} inside the window passes`, async () => {
      const { guard, auditDenied } = harness(superAdmin(minutesAgo(29)));
      await expect(enforceRoutePermissions(guard, method, path, HEADERS)).resolves.toBeUndefined();
      expect(auditDenied).not.toHaveBeenCalled();
    });
  }

  it('a non-dangerous route never asks for a fresh sign-in', async () => {
    const { guard } = harness(superAdmin(minutesAgo(11 * 60)));
    await expect(
      enforceRoutePermissions(guard, 'GET', '/api/v1/admin/users', HEADERS),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the sign-in time is unknown', async () => {
    const { guard } = harness(superAdmin(undefined));
    await expect(guard.requireRecentAuth(superAdmin(undefined), 'r')).rejects.toMatchObject({
      status: 401,
      code: ErrorCodes.REAUTH_REQUIRED,
    });
  });

  it('fails closed when the guard was built without a window', async () => {
    const ctx = superAdmin(NOW);
    const { guard } = harness(ctx, { reauthWindowSeconds: undefined });
    await expect(guard.requireRecentAuth(ctx, 'r')).rejects.toMatchObject({
      code: ErrorCodes.REAUTH_REQUIRED,
    });
  });

  it('recentAuth is only declared on session routes that also declare permissions', () => {
    for (const entry of ROUTE_REGISTRY.filter((e) => e.recentAuth)) {
      expect(['admin', 'builder-session']).toContain(entry.auth);
      expect(entry.permissions.length + (entry.permissionsAnyOf?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});
