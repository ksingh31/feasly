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
