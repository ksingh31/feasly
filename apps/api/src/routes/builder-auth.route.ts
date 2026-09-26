/**
 * Thin builder-auth route (embed/09). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - `POST /api/v1/builder/auth/request` — email → magic link (or identical
 *   no-op for non-allowlisted). No auth required (public by design).
 * - `GET /api/v1/builder/auth/verify?token=…` — consumes the magic link,
 *   creates the session. Returns the `Set-Cookie` value for the adapter.
 * - `GET /api/v1/builder/auth/me` — returns the session identity.
 *   Requires a valid session (guarded by the adapter).
 * - `POST /api/v1/builder/auth/logout` — revokes the session cookie.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  BuilderAuthLogoutResponse,
  BuilderAuthMeResponse,
  BuilderAuthRequestResponse,
  BuilderAuthVerifyResponse,
} from '@feasly/contracts';
import {
  BUILDER_SESSION_COOKIE,
  parseBuilderSessionCookie,
} from '../middleware/builder-guard';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { BuilderAuthService } from '../services/builder-auth.service';

export interface BuilderAuthRouteDeps {
  readonly builderAuth: BuilderAuthService;
  /** Session TTL seconds — for the Max-Age cookie attribute. From config. */
  readonly builderSessionTtlSeconds: number;
}

export interface BuilderAuthRoute {
  /** POST /api/v1/builder/auth/request */
  request(body: unknown): Promise<BuilderAuthRequestResponse>;
  /**
   * GET /api/v1/builder/auth/verify?token=… — returns the response plus the
   * `Set-Cookie` header value for the adapter to set.
   */
  verify(query: unknown): Promise<BuilderAuthVerifyResponse>;
  /**
   * GET /api/v1/builder/auth/me — returns the session identity.
   * Requires a valid session (guarded by the adapter).
   */
  me(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderAuthMeResponse>;
  /**
   * POST /api/v1/builder/auth/logout — returns the response plus the
   * `Set-Cookie` (clearing) header value for the adapter to set.
   */
  logout(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderAuthLogoutResponse>;
}

const verifyQuerySchema = z.object({
  token: z.string().trim().min(1).max(500),
});

/**
 * Build the `Set-Cookie` value for the builder session. `Secure` is safe:
 * browsers treat http://localhost as a secure context, and production is
 * HTTPS-only.
 */
export function buildBuilderSessionCookie(
  sessionToken: string,
  maxAgeSeconds: number,
): string {
  const encoded = encodeURIComponent(sessionToken);
  return (
    `${BUILDER_SESSION_COOKIE}=${encoded}; ` +
    `HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}; Path=/`
  );
}

/** Expired cookie value that clears the session. */
export function buildClearBuilderSessionCookie(): string {
  return `${BUILDER_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}

export function createBuilderAuthRoute(
  deps: BuilderAuthRouteDeps,
): BuilderAuthRoute {
  const { builderAuth, builderSessionTtlSeconds } = deps;

  return {
    request: (body: unknown): Promise<BuilderAuthRequestResponse> =>
      builderAuth.requestMagicLink(body),

    async verify(query: unknown): Promise<BuilderAuthVerifyResponse> {
      const parsed = verifyQuerySchema.safeParse(query);
      // Malformed input gets the same denial as an invalid token — the
      // service throws the uniform 401 for empty/unknown tokens.
      const token = parsed.success ? parsed.data.token : '';
      const { authenticated, email, tenantKey, sessionToken } =
        await builderAuth.verifyMagicLink(token);
      return {
        authenticated,
        email,
        tenantKey,
        sessionToken,
        setCookie: buildBuilderSessionCookie(
          sessionToken,
          builderSessionTtlSeconds,
        ),
      };
    },

    async me(headers): Promise<BuilderAuthMeResponse> {
      const token = parseBuilderSessionCookie(headers);
      const session = await builderAuth.validateSession(token);
      if (session === null) {
        // Distinguish expired from invalid so the frontend can show the
        // specific "session expired" copy. Both are 401.
        const expired = await builderAuth.isSessionExpired(token);
        throw new HttpError(
          401,
          expired ? ErrorCodes.SESSION_EXPIRED : ErrorCodes.UNAUTHENTICATED,
          'Builder authentication required.',
          false,
        );
      }
      return {
        authenticated: true as const,
        email: session.email,
        tenantKey: session.tenantKey,
      };
    },

    async logout(headers): Promise<BuilderAuthLogoutResponse> {
      const token = parseBuilderSessionCookie(headers);
      const { loggedOut } = await builderAuth.logout(token);
      return { loggedOut, setCookie: buildClearBuilderSessionCookie() };
    },
  };
}
