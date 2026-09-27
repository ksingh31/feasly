/**
 * Session builder guard tests (embed/09).
 *
 * The guard is fail-closed: missing/invalid/expired/revoked sessions → 401.
 * The token arrives as `Authorization: Bearer <token>` (the SPA bearer flow)
 * or the `feasly_builder_session` httpOnly cookie (same-origin future);
 * bearer wins when both are present.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILDER_SESSION_COOKIE,
  createSessionBuilderGuard,
  parseBuilderSessionCookie,
  type BuilderGuard,
} from '../src/middleware/builder-guard';
import type { HttpError } from '../src/middleware/errors';

const SESSION = { email: 'builder@example.com', tenantKey: 'elite-craft' };

function fakeBuilderAuth(validToken: string | null) {
  return {
    validateSession: async (token: string | null) =>
      token !== null && token === validToken ? { ...SESSION } : null,
  };
}

async function rejected(
  guard: BuilderGuard,
  headers: Record<string, string | string[] | undefined>,
): Promise<HttpError | null> {
  try {
    await guard.requireBuilder(headers);
    return null;
  } catch (e) {
    return e as HttpError;
  }
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${BUILDER_SESSION_COOKIE}=${encodeURIComponent(token)}` };
}

function makeGuard(validToken: string | null): BuilderGuard {
  return createSessionBuilderGuard({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    builderAuth: fakeBuilderAuth(validToken) as any,
  });
}

describe('session builder guard (embed/09)', () => {
  it('valid session cookie passes', async () => {
    const error = await rejected(makeGuard('tok123'), cookieHeader('tok123'));
    expect(error).toBeNull();
  });

  it('valid Bearer <redacted> passes (ADM-10 bearer flow)', async () => {
    const error = await rejected(makeGuard('tok123'), {
      authorization: 'Bearer tok123',
    });
    expect(error).toBeNull();
  });

  it('missing credentials → 401', async () => {
    const error = await rejected(makeGuard('tok123'), {});
    expect(error?.status).toBe(401);
    expect(error?.code).toBe('UNAUTHENTICATED');
  });

  it('unknown bearer token → 401', async () => {
    const error = await rejected(makeGuard('tok123'), {
      authorization: 'Bearer wrong',
    });
    expect(error?.status).toBe(401);
  });

  it('malformed bearer header → 401', async () => {
    for (const authorization of ['Bearer', 'Bearer   ', 'Basic tok123']) {
      const error = await rejected(makeGuard('tok123'), { authorization });
      expect(error?.status).toBe(401);
    }
  });

  it('bearer wins over the cookie when both are present', async () => {
    const guard = makeGuard('bearer-tok');
    const ok = await rejected(guard, {
      authorization: 'Bearer bearer-tok',
      cookie: `${BUILDER_SESSION_COOKIE}=wrong`,
    });
    expect(ok).toBeNull();
    const denied = await rejected(guard, {
      authorization: 'Bearer wrong',
      cookie: `${BUILDER_SESSION_COOKIE}=bearer-tok`,
    });
    expect(denied?.status).toBe(401);
  });

  it('getBuilderSession resolves the identity via the bearer token', async () => {
    const guard = makeGuard('tok123');
    await expect(guard.getBuilderSession({ authorization: 'Bearer tok123' })).resolves.toEqual(
      SESSION,
    );
    await expect(guard.getBuilderSession({})).resolves.toBeNull();
  });
});

describe('parseBuilderSessionCookie', () => {
  it('extracts the token from a multi-cookie header', () => {
    const headers = {
      cookie: `other=1; ${BUILDER_SESSION_COOKIE}=abc123`,
    };
    expect(parseBuilderSessionCookie(headers)).toBe('abc123');
  });

  it('returns null when absent', () => {
    expect(parseBuilderSessionCookie({})).toBeNull();
    expect(parseBuilderSessionCookie({ cookie: 'other=1' })).toBeNull();
  });
});
