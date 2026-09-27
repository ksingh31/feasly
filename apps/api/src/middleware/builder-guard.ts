/**
 * Builder guard (embed/09) — session-token auth.
 *
 * Builder endpoints require a valid session token: the opaque token is
 * SHA-256 hashed and looked up in `builder_sessions`; missing, revoked, or
 * expired sessions → 401 UNAUTHENTICATED. The guard also exposes the
 * builder's tenant_key so routes can scope every read to the builder's
 * own tenant.
 *
 * The token arrives as `Authorization: Bearer <token>` (the SPA bearer
 * flow — the cookie never sticks cross-origin) or, for a same-origin
 * future, the `feasly_builder_session` httpOnly cookie. Bearer wins when
 * both are present.
 *
 * Routes depend on the `BuilderGuard` interface, not this implementation.
 */
import { ErrorCodes, HttpError } from './errors';
import {
  extractSessionToken,
  parseCookieValue,
  type HeaderRecord,
} from './session-token';
import type {
  BuilderAuthService,
  BuilderSession,
} from '../services/builder-auth.service';

export interface BuilderGuard {
  /**
   * Throws 401 UNAUTHENTICATED when the request is not from a builder.
   * Async: the session lookup hits the database.
   */
  requireBuilder(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void>;
  /**
   * Returns the authenticated builder's session identity (email +
   * tenantKey), or null when unauthenticated. Used to scope lead reads to
   * the builder's tenant. Does not throw.
   */
  getBuilderSession(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderSession | null>;
}

export interface SessionBuilderGuardDeps {
  readonly builderAuth: BuilderAuthService;
}

/** The httpOnly session cookie name — must match the verify endpoint. */
export const BUILDER_SESSION_COOKIE = 'feasly_builder_session';

/**
 * Extract the session token from the `Cookie` header. Returns null when
 * absent or malformed (the guard treats it as unauthenticated).
 */
export function parseBuilderSessionCookie(
  headers: HeaderRecord,
): string | null {
  return parseCookieValue(headers, BUILDER_SESSION_COOKIE);
}

function unauthorized(): HttpError {
  return new HttpError(
    401,
    ErrorCodes.UNAUTHENTICATED,
    'Builder authentication required.',
    false,
  );
}

export function createSessionBuilderGuard(
  deps: SessionBuilderGuardDeps,
): BuilderGuard {
  async function resolveSession(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderSession | null> {
    const token = extractSessionToken(headers, BUILDER_SESSION_COOKIE);
    if (!token) return null;
    return deps.builderAuth.validateSession(token);
  }

  return {
    async requireBuilder(headers): Promise<void> {
      const session = await resolveSession(headers);
      if (!session) throw unauthorized();
    },
    async getBuilderSession(headers): Promise<BuilderSession | null> {
      return resolveSession(headers);
    },
  };
}
