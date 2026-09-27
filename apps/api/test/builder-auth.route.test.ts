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
    logout: vi.fn().mockResolvedValue({ loggedOut: true as const }),
  };
}

function makeRoute() {
  const builderAuth = makeService();
  const route = createBuilderAuthRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    builderAuth: builderAuth as any,
    builderSessionTtlSeconds: SESSION_TTL,
  });
  return { route, builderAuth };
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

  it('me accepts a Bearer <redacted>', async () => {
    const { route, builderAuth } = makeRoute();
    const result = await route.me({ authorization: 'Bearer bearer-tok' });
    expect(result).toEqual({
      authenticated: true,
      email: 'builder@example.com',
      tenantKey: 'elite-craft',
    });
    expect(builderAuth.validateSession).toHaveBeenCalledWith('bearer-tok');
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
    expect(builderAuth.logout).toHaveBeenCalledWith('bearer-tok');
  });
});
