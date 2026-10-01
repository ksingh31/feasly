/**
 * Builder auth route tests — bearer-token conformance (embed/09, ADM-10).
 *
 * The route is thin: validate input → call the service → shape the result.
 * The verify response carries the session token in the JSON body (the SPA
 * bearer flow); `me`/`logout` accept `Authorization: Bearer <token>` in
 * addition to the session cookie.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBuilderAuthRoute } from '../src/routes/builder-auth.route';
import { BUILDER_SESSION_COOKIE } from '../src/middleware/builder-guard';

const SESSION_TTL = 604_800;

function makeService() {
  return {
    requestMagicLink: vi.fn().mockResolvedValue({ sent: true }),
    verifyMagicLink: vi.fn().mockResolvedValue({
      authenticated: true as const,
      email: 'builder@example.com',
      tenantKey: 'elite-craft',
      sessionToken: 'raw-session-token',
    }),
    validateSession: vi.fn().mockResolvedValue({
      email: 'builder@example.com',
      tenantKey: 'elite-craft',
    }),
    isSessionExpired: vi.fn().mockResolvedValue(false),
    logout: vi.fn().mockResolvedValue({
      loggedOut: true as const,
      entraLogoutUrl:
        'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/logout',
    }),
  };
}

function makePermissionGuard() {
  return {
    getAuthContext: vi.fn().mockResolvedValue(null),
  };
}

function makeRoute() {
  const builderAuth = makeService();
  const permissionGuard = makePermissionGuard();
  const route = createBuilderAuthRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    builderAuth: builderAuth as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    permissionGuard: permissionGuard as any,
    builderSessionTtlSeconds: SESSION_TTL,
  });
  return { route, builderAuth, permissionGuard };
}

function authContext(role: 'builder_admin' | 'builder_member') {
  return {
    builderId: 'builder-1',
    memberships: [
      { builderId: 'builder-1', role, createdAt: new Date() },
      { builderId: 'builder-2', role: 'builder_member' as const, createdAt: new Date() },
    ],
  };
}

describe('builder auth route — bearer conformance (embed/09)', () => {
  it('verify → returns the sessionToken in the JSON body', async () => {
    const { route, builderAuth } = makeRoute();
    const result = await route.verify({ token: 'tok' });
    expect(result.authenticated).toBe(true);
    expect(result.email).toBe('builder@example.com');
    expect(result.tenantKey).toBe('elite-craft');
    expect(result.sessionToken).toBe('raw-session-token');
    // Set-Cookie is kept for a same-origin future.
    expect(result.setCookie).toContain(`${BUILDER_SESSION_COOKIE}=`);
    expect(builderAuth.verifyMagicLink).toHaveBeenCalledWith('tok');
  });

  it('me accepts a Bearer <redacted> — role null when no active membership', async () => {
    const { route, builderAuth, permissionGuard } = makeRoute();
    const result = await route.me({ authorization: 'Bearer bearer-tok' });
    expect(result).toEqual({
      authenticated: true,
      email: 'builder@example.com',
      tenantKey: 'elite-craft',
      role: null,
      // Builder-side view-as display state (2026-09-30, Karan): null when
      // the session is not viewing-as.
      viewAs: null,
      viewAsDisplayName: null,
      realEmail: null,
    });
    expect(builderAuth.validateSession).toHaveBeenCalledWith('bearer-tok');
    expect(permissionGuard.getAuthContext).toHaveBeenCalledWith({
      authorization: 'Bearer bearer-tok',
    });
  });

  it('me returns the builder_admin role of the active org', async () => {
    const { route, permissionGuard } = makeRoute();
    permissionGuard.getAuthContext.mockResolvedValue(authContext('builder_admin'));
    const result = await route.me({ authorization: 'Bearer bearer-tok' });
    expect(result.role).toBe('builder_admin');
  });

  it('me returns the builder_member role of the active org', async () => {
    const { route, permissionGuard } = makeRoute();
    permissionGuard.getAuthContext.mockResolvedValue(authContext('builder_member'));
    const result = await route.me({ authorization: 'Bearer bearer-tok' });
    expect(result.role).toBe('builder_member');
  });

  it('me returns role null when the auth context carries no active-builder membership', async () => {
    const { route, permissionGuard } = makeRoute();
    // Active builder is not among the user's memberships (e.g. membership
    // removed while the session still scopes to it).
    permissionGuard.getAuthContext.mockResolvedValue({
      builderId: 'builder-3',
      memberships: [
        { builderId: 'builder-1', role: 'builder_admin', createdAt: new Date() },
      ],
    });
    const result = await route.me({ authorization: 'Bearer bearer-tok' });
    expect(result.role).toBeNull();
    expect(result.authenticated).toBe(true);
  });

  it('me with an expired session → 401 SESSION_EXPIRED', async () => {
    const { route, builderAuth } = makeRoute();
    builderAuth.validateSession.mockResolvedValue(null);
    builderAuth.isSessionExpired.mockResolvedValue(true);
    await expect(route.me({ authorization: 'Bearer stale' })).rejects.toMatchObject({
      status: 401,
      code: 'SESSION_EXPIRED',
    });
  });

  it('me still accepts the session cookie', async () => {
    const { route, builderAuth } = makeRoute();
    await route.me({ cookie: `${BUILDER_SESSION_COOKIE}=cookie-tok` });
    expect(builderAuth.validateSession).toHaveBeenCalledWith('cookie-tok');
  });

  it('me with an unknown bearer token → 401 UNAUTHENTICATED', async () => {
    const { route, builderAuth } = makeRoute();
    builderAuth.validateSession.mockResolvedValue(null);
    await expect(route.me({ authorization: 'Bearer wrong' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('logout accepts a Bearer <redacted>', async () => {
    const { route, builderAuth } = makeRoute();
    const result = await route.logout({ authorization: 'Bearer bearer-tok' });
    expect(result.loggedOut).toBe(true);
    expect(result.setCookie).toContain('Max-Age=0');
    expect(result.entraLogoutUrl).toBe(
      'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/logout',
    );
    expect(builderAuth.logout).toHaveBeenCalledWith('bearer-tok');
  });
});
