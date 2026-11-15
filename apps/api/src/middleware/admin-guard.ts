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
import { createHash } from 'node:crypto';
import { ErrorCodes, HttpError } from './errors';
import {
  ADMIN_SESSION_COOKIE,
  extractSessionToken,
  parseCookieValue,
  type HeaderRecord,
} from './session-token';
import type { AdminAuthService } from '../services/admin-auth.service';
import {
  createRequestPipeline,
  type LogEntry,
  type RequestPipeline,
  type RequestPipelineDeps,
} from './pipeline';
import type { RateLimiter } from './rate-limit';

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
export { ADMIN_SESSION_COOKIE };

/**
 * Extract the session token from the `Cookie` header. Returns null when
 * absent or malformed (the guard treats it as unauthenticated).
 */
export function parseSessionCookie(headers: HeaderRecord): string | null {
  return parseCookieValue(headers, ADMIN_SESSION_COOKIE);
}

/**
 * Rate-limiter key for per-admin-session limits (e.g. the ⌘K search
 * pipeline). Uses the same token resolution as the guard (Bearer wins over
 * the cookie) and keys on the token's SHA-256 so the raw credential never
 * becomes a limiter map key. No token → `undefined` (the session limiter is
 * skipped; the per-IP primary limiter still throttles anonymous probing).
 *
 * The token is NOT verified here — the limiter runs before the guard — so
 * this key must only ever back a SECONDARY limiter behind a per-IP one.
 * On its own, rotating random tokens would get a fresh bucket each time.
 */
export function adminSessionRateLimitKey(request: {
  readonly headers: HeaderRecord;
}): string | undefined {
  const token = extractSessionToken(request.headers, ADMIN_SESSION_COOKIE);
  return token
    ? `session:${createHash('sha256').update(token, 'utf8').digest('hex')}`
    : undefined;
}

/**
 * Request pipeline for admin endpoints with a per-session budget (⌘K
 * search). The primary limiter is keyed per client IP and checked first, so
 * unverified tokens can't bypass throttling or flood the session limiter's
 * key map; the per-session limiter then applies when a token is presented.
 */
export function createAdminSearchPipeline(deps: {
  readonly ipLimiter: RateLimiter;
  readonly sessionLimiter: RateLimiter;
  readonly logger?: (entry: LogEntry) => void;
  readonly csrf?: RequestPipelineDeps['csrf'];
}): RequestPipeline {
  return createRequestPipeline({
    csrf: deps.csrf,
    rateLimiter: deps.ipLimiter,
    extraLimiters: [
      {
        limiter: deps.sessionLimiter,
        keyFor: adminSessionRateLimitKey,
        label: 'admin-session',
      },
    ],
    logger: deps.logger,
  });
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
