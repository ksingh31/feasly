/**
 * Admin guard (admin/01) — session-token auth.
 *
 * Replaces the interim pre-shared-key guard (api-mcp/01). Admin endpoints
 * require a valid session token: the opaque token is SHA-256 hashed and
 * looked up in `admin_sessions`; missing, revoked, or expired sessions →
 * 401 UNAUTHENTICATED.
 *
 * The token arrives as `Authorization: Bearer <token>` (the SPA bearer
 * flow — the cookie never sticks cross-origin) or, for a same-origin
 * future, the `feasly_admin_session` httpOnly cookie. Bearer wins when
 * both are present.
 *
 * Routes depend on the `AdminGuard` interface, not this implementation.
 */
import { ErrorCodes, HttpError } from './errors';
import {
  extractSessionToken,
  parseCookieValue,
  type HeaderRecord,
} from './session-token';
import type { AdminAuthService } from '../services/admin-auth.service';

export interface AdminGuard {
  /**
   * Throws 401 UNAUTHENTICATED when the request is not from an admin.
   * Async: the session lookup hits the database.
   */
  requireAdmin(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void>;
  /**
   * Returns the authenticated admin's email, or null when unauthenticated.
   * Used for audit rows (admin/02 AC4, AC6). Does not throw.
   */
  getAdminEmail(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<string | null>;
}

export interface SessionAdminGuardDeps {
  readonly adminAuth: AdminAuthService;
}

/** The httpOnly session cookie name — must match the verify endpoint. */
export const ADMIN_SESSION_COOKIE = 'feasly_admin_session';

/**
 * Extract the session token from the `Cookie` header. Returns null when
 * absent or malformed (the guard treats it as unauthenticated).
 */
export function parseSessionCookie(headers: HeaderRecord): string | null {
  return parseCookieValue(headers, ADMIN_SESSION_COOKIE);
}

function unauthorized(): HttpError {
  return new HttpError(
    401,
    ErrorCodes.UNAUTHENTICATED,
    'Admin authentication required.',
    false,
  );
}

export function createSessionAdminGuard(
  deps: SessionAdminGuardDeps,
): AdminGuard {
  async function resolveEmail(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<string | null> {
    const token = extractSessionToken(headers, ADMIN_SESSION_COOKIE);
    if (!token) return null;
    return deps.adminAuth.validateSession(token);
  }

  return {
    async requireAdmin(headers): Promise<void> {
      const email = await resolveEmail(headers);
      if (!email) throw unauthorized();
    },
    async getAdminEmail(headers): Promise<string | null> {
      return resolveEmail(headers);
    },
  };
}
