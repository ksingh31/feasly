/**
 * Admin auth route tests (admin/01).
 *
 * The route is thin: validate input → call the service → shape the result
 * (including the Set-Cookie value for the adapter).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createAdminAuthRoute,
} from '../src/routes/admin-auth.route';
import { ADMIN_SESSION_COOKIE } from '../src/middleware/admin-guard';

const SESSION_TTL = 604_800;

function makeService() {
  return {
    requestMagicLink: vi.fn().mockResolvedValue({ sent: true }),
    verifyMagicLink: vi
      .fn()
      .mockResolvedValue({
        authenticated: true as const,
        email: 'admin@example.com',
        sessionToken: 'raw-session-token',
      }),
    validateSession: vi.fn().mockResolvedValue('admin@example.com'),
    isSessionExpired: vi.fn().mockResolvedValue(false),
    logout: vi.fn().mockResolvedValue({ loggedOut: true as const }),
  };
}

function makeRoute() {
  const adminAuth = makeService();
  const route = createAdminAuthRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminAuth: adminAuth as any,
    adminSessionTtlSeconds: SESSION_TTL,
  });
  return { route, adminAuth };
}

describe('admin auth route (admin/01)', () => {
  it('request → delegates to service, returns { sent: true }', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.request({ email: 'admin@example.com' });
    expect(result).toEqual({ sent: true });
    expect(adminAuth.requestMagicLink).toHaveBeenCalledWith({
      email: 'admin@example.com',
    });
  });

  it('verify → returns authenticated + sessionToken + Set-Cookie value', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.verify({ token: 'tok' });
    expect(result.authenticated).toBe(true);
    expect(result.email).toBe('admin@example.com');
    expect(result.sessionToken).toBe('raw-session-token');
    expect(result.setCookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('SameSite=Lax');
    expect(result.setCookie).toContain(`Max-Age=${SESSION_TTL}`);
    expect(adminAuth.verifyMagicLink).toHaveBeenCalledWith('tok');
  });

  it('verify with malformed query → service throws (uniform 401)', async () => {
    const { route, adminAuth } = makeRoute();
    adminAuth.verifyMagicLink.mockRejectedValue(
      Object.assign(new Error('denied'), { status: 401 }),
    );
    await expect(route.verify({})).rejects.toMatchObject({ status: 401 });
    expect(adminAuth.verifyMagicLink).toHaveBeenCalledWith('');
  });

  it('me → returns session identity', async () => {
    const { route, adminAuth } = makeRoute();
    const result = await route.me({
      cookie: `${ADMIN_SESSION_COOKIE}=tok123`,
    });
    expect(result).toEqual({
      authenticated: true,
      email: 'admin@example.com',
    });
    expect(adminAuth.validateSession).toHaveBeenCalledWith('tok123');
  });

  it('me with invalid session → 401 UNAUTHENTICATED', async () => {
    const { route, adminAuth } = makeRoute();
    adminAuth.validateSession.mockResolvedValue(null);
    adminAuth.isSessionExpired.mockResolvedValue(false);
    await expect(route.me({})).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('me with expired session → 401 SESSION_EXPIRED', async () => {
    const { route, adminAuth } = makeRoute();
    adminAuth.validateSession.mockResolvedValue(null);
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
      `${ADMIN_SESSION_COOKIE}=tok; HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=/`,
    );
  });

  it('buildClearSessionCookie expires immediately', () => {
    const value = buildClearSessionCookie();
    expect(value).toContain('Max-Age=0');
  });
});
