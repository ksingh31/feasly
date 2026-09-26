/**
 * Thin admin-auth route (admin/01). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - `POST /api/v1/admin/auth/request` — email → magic link (or identical
 *   no-op for non-allowlisted). No auth required (public by design).
 * - `GET /api/v1/admin/auth/verify?token=…` — consumes the magic link,
 *   creates the session. Returns the `Set-Cookie` value for the adapter.
 * - `POST /api/v1/admin/auth/logout` — revokes the session cookie.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  AdminAuthLogoutResponse,
  AdminAuthMeResponse,
  AdminAuthRequestResponse,
  AdminAuthVerifyResponse,
} from '@feasly/contracts';
import {
  ADMIN_SESSION_COOKIE,
  parseSessionCookie,
} from '../middleware/admin-guard';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuthService } from '../services/admin-auth.service';

export interface AdminAuthRouteDeps {
  readonly adminAuth: AdminAuthService;
  /** Session TTL seconds — for the Max-Age cookie attribute. From config. */
  readonly adminSessionTtlSeconds: number;
}

export interface AdminAuthRoute {
  /** POST /api/v1/admin/auth/request */
  request(body: unknown): Promise<AdminAuthRequestResponse>;
  /**
   * GET /api/v1/admin/auth/verify?token=… — returns the response plus the
   * `Set-Cookie` header value for the adapter to set.
   */
  verify(query: unknown): Promise<AdminAuthVerifyResponse>;
  /**
   * GET /api/v1/admin/auth/me — returns the session identity.
   * Requires a valid session (guarded by the adapter).
   */
  me(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AdminAuthMeResponse>;
  /**
   * POST /api/v1/admin/auth/logout — returns the response plus the
   * `Set-Cookie` (clearing) header value for the adapter to set.
   */
  logout(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AdminAuthLogoutResponse>;
}

const verifyQuerySchema = z.object({
  token: z.string().trim().min(1).max(500),
});

/**
 * Build the `Set-Cookie` value for the admin session. `Secure` is safe:
 * browsers treat http://localhost as a secure context, and production is
 * HTTPS-only. `SameSite=None` is required because the web app calls the API
 * cross-origin (ADM-10: SWA Free SKU rejects linked backends, so the Angular
 * app talks to the Function App URL directly with CORS + credentials) —
 * `SameSite=Lax` would never send the cookie cross-site.
 */
export function buildSessionCookie(
  sessionToken: string,
  maxAgeSeconds: number,
): string {
  const encoded = encodeURIComponent(sessionToken);
  return (
    `${ADMIN_SESSION_COOKIE}=${encoded}; ` +
    `HttpOnly; Secure; SameSite=None; Max-Age=${maxAgeSeconds}; Path=/`
  );
}

/** Expired cookie value that clears the session. */
export function buildClearSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=None; Max-Age=0; Path=/`;
}

export function createAdminAuthRoute(
  deps: AdminAuthRouteDeps,
): AdminAuthRoute {
  const { adminAuth, adminSessionTtlSeconds } = deps;

  return {
    request: (body: unknown): Promise<AdminAuthRequestResponse> =>
      adminAuth.requestMagicLink(body),

    async verify(query: unknown): Promise<AdminAuthVerifyResponse> {
      const parsed = verifyQuerySchema.safeParse(query);
      // Malformed input gets the same denial as an invalid token — the
      // service throws the uniform 401 for empty/unknown tokens.
      const token = parsed.success ? parsed.data.token : '';
      const { authenticated, email, sessionToken } =
        await adminAuth.verifyMagicLink(token);
      return {
        authenticated,
        email,
        sessionToken,
        setCookie: buildSessionCookie(sessionToken, adminSessionTtlSeconds),
      };
    },

    async me(headers): Promise<AdminAuthMeResponse> {
      const token = parseSessionCookie(headers);
      const email = await adminAuth.validateSession(token);
      if (email === null) {
        // Distinguish expired from invalid so the frontend can show the
        // specific "session expired" copy. Both are 401.
        const expired = await adminAuth.isSessionExpired(token);
        throw new HttpError(
          401,
          expired ? ErrorCodes.SESSION_EXPIRED : ErrorCodes.UNAUTHENTICATED,
          'Admin authentication required.',
          false,
        );
      }
      return { authenticated: true as const, email };
    },

    async logout(headers): Promise<AdminAuthLogoutResponse> {
      const token = parseSessionCookie(headers);
      const { loggedOut } = await adminAuth.logout(token);
      return { loggedOut, setCookie: buildClearSessionCookie() };
    },
  };
}
