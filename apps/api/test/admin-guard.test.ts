/**
 * Session admin guard tests (admin/01).
 *
 * The guard is fail-closed: missing/invalid/expired/revoked sessions → 401.
 * Replaces the interim pre-shared-key guard (api-mcp/01).
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_SESSION_COOKIE,
  createSessionAdminGuard,
  parseSessionCookie,
  type AdminGuard,
} from '../src/middleware/admin-guard';
import type { HttpError } from '../src/middleware/errors';

const NOW = new Date('2026-09-24T12:00:00Z');

function fakeAdminAuth(validToken: string | null) {
  return {
    validateSession: async (token: string | null) =>
      token !== null && token === validToken ? 'admin@example.com' : null,
  };
}

async function rejected(
  guard: AdminGuard,
  headers: Record<string, string | string[] | undefined>,
): Promise<HttpError | null> {
  try {
    await guard.requireAdmin(headers);
    return null;
  } catch (e) {
    return e as HttpError;
  }
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}` };
}

describe('session admin guard (admin/01)', () => {
  it('valid session cookie passes', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('tok123') as any,
    });
    const error = await rejected(guard, cookieHeader('tok123'));
    expect(error).toBeNull();
  });

  it('missing cookie → 401', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('tok123') as any,
    });
    const error = await rejected(guard, {});
    expect(error?.status).toBe(401);
    expect(error?.code).toBe('UNAUTHENTICATED');
  });

  it('unknown token → 401', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('tok123') as any,
    });
    const error = await rejected(guard, cookieHeader('wrong'));
    expect(error?.status).toBe(401);
  });

  it('no valid session configured → fail closed', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth(null) as any,
    });
    const error = await rejected(guard, cookieHeader('anything'));
    expect(error?.status).toBe(401);
  });

  it('valid Bearer <redacted> passes (ADM-10 bearer flow)', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('tok123') as any,
    });
    const error = await rejected(guard, { authorization: 'Bearer tok123' });
    expect(error).toBeNull();
  });

  it('unknown bearer token → 401', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('tok123') as any,
    });
    const error = await rejected(guard, { authorization: 'Bearer wrong' });
    expect(error?.status).toBe(401);
    expect(error?.code).toBe('UNAUTHENTICATED');
  });

  it('malformed bearer header → 401', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('tok123') as any,
    });
    for (const authorization of ['Bearer', 'Bearer   ', 'Basic tok123']) {
      const error = await rejected(guard, { authorization });
      expect(error?.status).toBe(401);
    }
  });

  it('bearer wins over the cookie when both are present', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('bearer-tok') as any,
    });
    // Valid bearer + invalid cookie → passes on the bearer.
    const ok = await rejected(guard, {
      authorization: 'Bearer bearer-tok',
      cookie: `${ADMIN_SESSION_COOKIE}=wrong`,
    });
    expect(ok).toBeNull();
    // Invalid bearer + valid cookie → the bearer is malformed auth, 401.
    const denied = await rejected(guard, {
      authorization: 'Bearer wrong',
      cookie: `${ADMIN_SESSION_COOKIE}=bearer-tok`,
    });
    expect(denied?.status).toBe(401);
  });

  it('getAdminEmail resolves via the bearer token', async () => {
    const guard = createSessionAdminGuard({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminAuth: fakeAdminAuth('tok123') as any,
    });
    await expect(guard.getAdminEmail({ authorization: 'Bearer tok123' })).resolves.toBe(
      'admin@example.com',
    );
    await expect(guard.getAdminEmail({})).resolves.toBeNull();
  });
});

describe('parseSessionCookie', () => {
  it('extracts the token from a multi-cookie header', () => {
    const headers = {
      cookie: `other=1; ${ADMIN_SESSION_COOKIE}=abc123; third=2`,
    };
    expect(parseSessionCookie(headers)).toBe('abc123');
  });

  it('returns null when absent', () => {
    expect(parseSessionCookie({})).toBeNull();
    expect(parseSessionCookie({ cookie: 'other=1' })).toBeNull();
  });

  it('decodes URI-encoded values', () => {
    const headers = {
      cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent('a/b+c')}`,
    };
    expect(parseSessionCookie(headers)).toBe('a/b+c');
  });

  it('handles array header values', () => {
    const headers = { cookie: [`${ADMIN_SESSION_COOKIE}=tok`] };
    expect(parseSessionCookie(headers)).toBe('tok');
  });
});

void NOW;
