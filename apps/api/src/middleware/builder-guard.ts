/**
 * Builder guard (embed/09) — session-cookie auth.
 *
 * Builder endpoints require a valid `feasly_builder_session` httpOnly
 * cookie: the opaque token is SHA-256 hashed and looked up in
 * `builder_sessions`; missing, revoked, or expired sessions → 401
 * UNAUTHENTICATED. The guard also exposes the builder's tenant_key so
 * routes can scope every read to the builder's own tenant.
 *
 * Routes depend on the `BuilderGuard` interface, not this implementation.
 */
import { ErrorCodes, HttpError } from './errors';
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
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers['cookie'];
  const cookieHeader = Array.isArray(raw) ? raw[0] : raw;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === BUILDER_SESSION_COOKIE) {
      const value = part.slice(idx + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
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
    const token = parseBuilderSessionCookie(headers);
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
