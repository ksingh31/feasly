/**
 * Admin guard (admin/01) — session-cookie auth.
 *
 * Replaces the interim pre-shared-key guard (api-mcp/01). Admin endpoints
 * require a valid `feasly_admin_session` httpOnly cookie: the opaque token
 * is SHA-256 hashed and looked up in `admin_sessions`; missing, revoked, or
 * expired sessions → 401 UNAUTHENTICATED.
 *
 * Routes depend on the `AdminGuard` interface, not this implementation.
 */
import { ErrorCodes, HttpError } from './errors';
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
export function parseSessionCookie(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers['cookie'];
  const cookieHeader = Array.isArray(raw) ? raw[0] : raw;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === ADMIN_SESSION_COOKIE) {
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
    const token = parseSessionCookie(headers);
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
