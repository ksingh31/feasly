/**
 * Admin auth route tests (auth/02).
 *
 * The route is thin: validate input → call the service → shape the result
 * (including the Set-Cookie value for the adapter). The legacy magic-link
 * endpoints were retired 2026-09-28, Karan.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createAdminAuthRoute,
} from '../src/routes/admin-auth.route';
import { ADMIN_SESSION_COOKIE } from '../src/middleware/admin-guard';

function makeService() {
  return {
    validateSession: vi.fn().mockResolvedValue('admin@example.com'),
    isSessionExpired: vi.fn().mockResolvedValue(false),
    logout: vi.fn().mockResolvedValue({ loggedOut: true as const }),
  };
}

function makeRoute(opts: { context?: unknown } = {}) {
  const adminAuth = makeService();
  // auth/04: /me now returns the session's authorization context, so the
  // fake guard returns a realistic context instead of null.
  const context =
    opts.context !== undefined
      ? opts.context
      : {
          userId: 'user-1',
          email: 'admin@example.com',
          name: 'Karan',
          staffRole: 'admin',
          permissions: ['leads:read', 'builders:read'],
          builderId: null,
          builderName: null,
          memberships: [],
          viewAs: null,
          realUser: null,
        };
  const route = createAdminAuthRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminAuth: adminAuth as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    permissionGuard: { getAuthContext: async () => context } as any,
  });
  return { route, adminAuth };
}

describe('admin auth route (auth/02)', () => {
  it('me → returns session identity', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.me({
      cookie: `${ADMIN_SESSION_COOKIE}=tok123`,
    });
    expect(result).toEqual({
      authenticated: true,
      email: 'admin@example.com',
      authContext: {
        userId: 'user-1',
        name: 'Karan',
        staffRole: 'admin',
        permissions: ['leads:read', 'builders:read'],
        builderId: null,
        builderName: null,
        memberships: [],
        viewAs: null,
        realUser: null,
      },
    });
  });

  it('me accepts a Bearer <redacted> (ADM-10 bearer flow)', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.me({
      authorization: 'Bearer bearer-tok',
    });
    expect(result.authenticated).toBe(true);
    expect(result.authContext?.permissions).toEqual([
      'leads:read',
      'builders:read',
    ]);
  });

  it('me exposes the session authorization context', async () => {
    const { route } = makeRoute();
    const result = await route.me({ authorization: 'Bearer <redacted>' });
    expect(result.authContext?.staffRole).toBe('admin');
    expect(result.authContext?.userId).toBe('user-1');
  });

  it('me with invalid session → 401 UNAUTHENTICATED', async () => {
    const { route, adminAuth } = makeRoute({ context: null });
    adminAuth.isSessionExpired.mockResolvedValue(false);
    await expect(route.me({})).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('me with expired session → 401 SESSION_EXPIRED', async () => {
    const { route, adminAuth } = makeRoute({ context: null });
    adminAuth.isSessionExpired.mockResolvedValue(true);
    await expect(route.me({})).rejects.toMatchObject({
      status: 401,
      code: 'SESSION_EXPIRED',
    });
  });

  it('logout → revokes via service, returns clearing cookie', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.logout({
      cookie: `${ADMIN_SESSION_COOKIE}=tok123`,
    });
    expect(result.loggedOut).toBe(true);
    expect(result.setCookie).toContain('Max-Age=0');
    expect(adminAuth.logout).toHaveBeenCalledWith('tok123');
  });

  it('logout accepts a Bearer <redacted> (ADM-10 bearer flow)', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.logout({
      authorization: 'Bearer bearer-tok',
    });
    expect(result.loggedOut).toBe(true);
    expect(adminAuth.logout).toHaveBeenCalledWith('bearer-tok');
  });

  it('logout without cookie → still succeeds', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.logout({});
    expect(result.loggedOut).toBe(true);
    expect(adminAuth.logout).toHaveBeenCalledWith(null);
  });
});

describe('cookie builders', () => {
  it('buildSessionCookie sets secure attributes', () => {
    const value = buildSessionCookie('tok', 604800);
    expect(value).toBe(
      `${ADMIN_SESSION_COOKIE}=tok; HttpOnly; Secure; SameSite=None; Max-Age=604800; Path=/`,
    );
  });

  it('buildClearSessionCookie expires immediately', () => {
    const value = buildClearSessionCookie();
    expect(value).toContain('Max-Age=0');
  });
});
