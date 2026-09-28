/**
 * Thin builder Entra-callback route (auth/05). Routes are adapters, not
 * logic: call exactly one service method, then attach the `Set-Cookie`
 * value for the adapter (the JSON body the client sees matches the
 * contract byte-for-byte — the adapter strips `setCookie` into the
 * header, same as the magic-link verify route).
 *
 * - `POST /api/v1/builder/auth/entra/callback` — `{ code, codeVerifier,
 *   redirectUri }` → `{ authenticated, user: { email, name, memberships },
 *   activeBuilderId, sessionToken }`. Public by design (it IS the
 *   sign-in); Entra owns credential brute-force, our dedicated pipeline
 *   rate-limits code-replay abuse (10 attempts per IP per 15 min).
 * - `GET /api/v1/builder/auth/memberships` — the caller's org memberships
 *   + the session's active builder. Requires a builder session.
 * - `POST /api/v1/builder/auth/active-org` — switch the session's active
 *   builder (org switcher). The builder id must be one of the caller's
 *   memberships.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */

// ---------------------------------------------------------------------------
// Contract shapes — imported from `@feasly/contracts`, the single source
// of truth shared with the frontend lane.
// ---------------------------------------------------------------------------
import type {
  BuilderActiveOrgResponse,
  BuilderEntraCallbackBody,
  BuilderEntraCallbackResponse,
  BuilderMembershipsResponse,
} from '@feasly/contracts';
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { buildBuilderSessionCookie } from '../builder-auth.route';
import { BUILDER_SESSION_COOKIE } from '../../middleware/builder-guard';
import { hashSessionToken } from '../../services/admin-auth.service';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import { extractSessionToken } from '../../middleware/session-token';
import type { PermissionGuard } from '../../middleware/permission-guard';
import type { BuilderEntraCallbackService } from '../../services/builder-entra-callback.service';

export interface BuilderEntraCallbackRouteDeps {
  readonly entraCallback: BuilderEntraCallbackService;
  /** Session TTL seconds — for the Max-Age cookie attribute. From config. */
  readonly builderSessionTtlSeconds: number;
  readonly permissionGuard: PermissionGuard;
}

export interface BuilderEntraCallbackRoute {
  /**
   * POST /api/v1/builder/auth/entra/callback — returns the contract
   * response plus the `Set-Cookie` header value for the adapter to set.
   */
  callback(
    body: unknown,
  ): Promise<BuilderEntraCallbackResponse & { readonly setCookie: string }>;
  /**
   * GET /api/v1/builder/auth/memberships — the caller's org memberships
   * plus the session's active builder. Requires a builder session.
   */
  memberships(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BuilderMembershipsResponse>;
  /**
   * POST /api/v1/builder/auth/active-org — switch the session's active
   * builder. The builder id must be one of the caller's memberships.
   */
  setActiveOrg(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<BuilderActiveOrgResponse>;
}

const activeOrgBodySchema = z.object({
  builderId: z.string().trim().uuid().max(100),
});

function requireSessionUserId(
  headers: Record<string, string | string[] | undefined>,
  permissionGuard: PermissionGuard,
): Promise<{ userId: string; activeBuilderId: string | null }> {
  return permissionGuard.getAuthContext(headers).then((ctx) => {
    if (!ctx || !ctx.userId) {
      throw new HttpError(
        401,
        ErrorCodes.UNAUTHENTICATED,
        'Builder authentication required.',
        false,
      );
    }
    return { userId: ctx.userId, activeBuilderId: ctx.builderId };
  });
}

export function createBuilderEntraCallbackRoute(
  deps: BuilderEntraCallbackRouteDeps,
): BuilderEntraCallbackRoute {
  const { entraCallback, builderSessionTtlSeconds, permissionGuard } = deps;

  return {
    async callback(body: unknown) {
      const result = await entraCallback.handleCallback(
        body as BuilderEntraCallbackBody,
      );
      return {
        authenticated: result.authenticated,
        user: result.user,
        activeBuilderId: result.activeBuilderId,
        sessionToken: result.sessionToken,
        setCookie: buildBuilderSessionCookie(
          result.sessionToken,
          builderSessionTtlSeconds,
        ),
      };
    },

    async memberships(headers) {
      const { userId, activeBuilderId } = await requireSessionUserId(
        headers,
        permissionGuard,
      );
      const { memberships } = await entraCallback.listMemberships(userId);
      return { memberships, activeBuilderId };
    },

    async setActiveOrg(headers, body) {
      const { userId } = await requireSessionUserId(headers, permissionGuard);
      const parsed = activeOrgBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A valid builder id is required.',
          false,
        );
      }
      const token = extractSessionToken(headers, BUILDER_SESSION_COOKIE);
      if (!token) {
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'Builder authentication required.',
          false,
        );
      }
      return entraCallback.setActiveOrg(
        hashSessionToken(token),
        userId,
        parsed.data.builderId,
      );
    },
  };
}
