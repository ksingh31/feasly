/**
 * Thin admin-auth route (auth/02). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * The legacy magic-link endpoints (`POST /api/v1/admin/auth/request`,
 * `GET /api/v1/admin/auth/verify`) were retired 2026-09-28 (Karan) —
 * Entra email+password is the only admin sign-in. Remaining:
 * - `GET /api/v1/admin/auth/me` — returns the session identity.
 *   Requires a valid session (guarded by the adapter).
 * - `POST /api/v1/admin/auth/logout` — revokes the session cookie.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type {
  AdminAuthLogoutResponse,
  AdminAuthMeResponse,
} from '@feasly/contracts';
import { ADMIN_SESSION_COOKIE } from '../middleware/admin-guard';
import { extractSessionToken } from '../middleware/session-token';
import type { PermissionGuard } from '../middleware/permission-guard';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuthService } from '../services/admin-auth.service';

export interface AdminAuthRouteDeps {
  readonly adminAuth: AdminAuthService;
  /** auth/04: resolves the session to its authorization context. */
  readonly permissionGuard: PermissionGuard;
}

export interface AdminAuthRoute {
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

/**
 * Build the `Set-Cookie` value for the admin session. `Secure` is safe:
 * browsers treat http://localhost as a secure context, and production is
 * HTTPS-only. `SameSite=None` is required because the web app calls the API
 * cross-origin (ADM-10: SWA Free SKU rejects linked backends, so the Angular
 * app talks to the Function App URL directly with CORS + credentials) —
 * `SameSite=Lax` would never send the cookie cross-site.
 *
 * Kept as a same-origin fallback: modern browsers block this third-party
 * cookie cross-origin, so the SPA primarily authenticates with the bearer
 * token returned in the callback JSON body.
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
  const { adminAuth, permissionGuard } = deps;

  return {
    async me(headers): Promise<AdminAuthMeResponse> {
      const ctx = await permissionGuard.getAuthContext(headers);
      if (ctx === null) {
        // Distinguish expired from invalid so the frontend can show the
        // specific "session expired" copy. Both are 401.
        const token = extractSessionToken(headers, ADMIN_SESSION_COOKIE);
        const expired = await adminAuth.isSessionExpired(token);
        throw new HttpError(
          401,
          expired ? ErrorCodes.SESSION_EXPIRED : ErrorCodes.UNAUTHENTICATED,
          'Admin authentication required.',
          false,
        );
      }
      // auth/04: expose the session's authorization context (permissions,
      // active builder, view-as state) so the admin shell can render the
      // view-as banner and the org switcher. Backend remains authoritative;
      // the frontend uses this for display only.
      return {
        authenticated: true as const,
        email: ctx.email,
        authContext: {
          userId: ctx.userId,
          name: ctx.name,
          staffRole: ctx.staffRole,
          permissions: [...ctx.permissions],
          builderId: ctx.builderId,
          builderName: ctx.builderName,
          memberships: ctx.memberships.map((m) => ({
            builderId: m.builderId,
            role: m.role,
          })),
          viewAs: ctx.viewAs,
          realUser: ctx.realUser,
        },
      };
    },

    async logout(headers): Promise<AdminAuthLogoutResponse> {
      const token = extractSessionToken(headers, ADMIN_SESSION_COOKIE);
      const { loggedOut } = await adminAuth.logout(token);
      return { loggedOut, setCookie: buildClearSessionCookie() };
    },
  };
}
