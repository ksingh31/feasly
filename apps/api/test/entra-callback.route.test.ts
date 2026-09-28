/**
 * Entra callback route tests (auth/02).
 *
 * The route is thin: delegate to the service, attach the Set-Cookie value
 * for the adapter. Also asserts the JSON body the client sees (minus the
 * adapter-only `setCookie`) matches the story contract byte-for-byte:
 * `{ authenticated: true, user: { email, name, staffRole }, sessionToken }`.
 *
 * NOTE: `@feasly/contracts` does not define AdminEntraCallbackBody /
 * AdminEntraCallbackResponse yet (frontend lane PR unmerged). When it does,
 * this test should validate against the contract types and the route's
 * local shapes should be deleted (see the DEDUPE comment in the route).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminEntraCallbackRoute,
  type AdminEntraCallbackResponse,
} from '../src/routes/admin/entra-callback';
import { ADMIN_SESSION_COOKIE } from '../src/middleware/admin-guard';

const SESSION_TTL = 604_800;

function makeRoute() {
  const entraCallback = {
    handleCallback: vi.fn().mockResolvedValue({
      authenticated: true as const,
      user: {
        email: 'admin@example.com',
        name: 'Ada Admin',
        staffRole: 'admin',
      },
      sessionToken: 'raw-session-token',
    }),
  };
  const route = createAdminEntraCallbackRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entraCallback: entraCallback as any,
    adminSessionTtlSeconds: SESSION_TTL,
  });
  return { route, entraCallback };
}

describe('entra callback route (auth/02)', () => {
  it('delegates to the service and returns the contract shape + setCookie', async () => {
    const { route, entraCallback } = makeRoute();
    const body = {
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/admin/auth/callback',
    };
    const result = await route.callback(body);

    expect(entraCallback.handleCallback).toHaveBeenCalledWith(body);
    expect(result.authenticated).toBe(true);
    expect(result.user).toEqual({
      email: 'admin@example.com',
      name: 'Ada Admin',
      staffRole: 'admin',
    });
    expect(result.sessionToken).toBe('raw-session-token');
    expect(result.setCookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('Secure');
    expect(result.setCookie).toContain('SameSite=None');
    expect(result.setCookie).toContain(`Max-Age=${SESSION_TTL}`);
  });

  it('client-visible JSON matches the contract byte-for-byte', async () => {
    const { route } = makeRoute();
    const result = await route.callback({ code: 'c', codeVerifier: 'v', redirectUri: 'u' });
    // The adapter strips `setCookie` into the Set-Cookie header — what the
    // SPA parses must be exactly the contract shape.
    const { setCookie: _stripped, ...clientBody } = result;
    const expected: AdminEntraCallbackResponse = {
      authenticated: true,
      user: { email: 'admin@example.com', name: 'Ada Admin', staffRole: 'admin' },
      sessionToken: 'raw-session-token',
    };
    expect(clientBody).toEqual(expected);
    expect(Object.keys(clientBody).sort()).toEqual(
      ['authenticated', 'sessionToken', 'user'],
    );
    expect(Object.keys(clientBody.user).sort()).toEqual(['email', 'name', 'staffRole']);
  });

  it('service errors propagate untouched', async () => {
    const { route, entraCallback } = makeRoute();
    entraCallback.handleCallback.mockRejectedValue(
      Object.assign(new Error('denied'), { status: 403 }),
    );
    const error = await route.callback({}).catch((e) => e);
    expect(error.status).toBe(403);
  });
});
