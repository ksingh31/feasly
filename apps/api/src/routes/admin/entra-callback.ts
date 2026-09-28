/**
 * Thin Entra-callback route (auth/02). Routes are adapters, not logic:
 * call exactly one service method, then attach the `Set-Cookie` value for
 * the adapter (the JSON body the client sees matches the contract
 * byte-for-byte — the adapter strips `setCookie` into the header, same as
 * the magic-link verify route).
 *
 * - `POST /api/v1/admin/auth/entra/callback` — `{ code, codeVerifier,
 *   redirectUri }` → `{ authenticated, user: { email, name, staffRole },
 *   sessionToken }`. Public by design (it IS the sign-in); Entra owns
 *   credential brute-force, our dedicated pipeline rate-limits code-replay
 *   abuse (10 attempts per IP per 15 min).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */

// ---------------------------------------------------------------------------
// Contract shapes — imported from `@feasly/contracts` (PR #269), the single
// source of truth shared with the frontend lane.
// ---------------------------------------------------------------------------
import type {
  AdminEntraCallbackBody,
  AdminEntraCallbackResponse,
} from '@feasly/contracts';
// ---------------------------------------------------------------------------

import { buildSessionCookie } from '../admin-auth.route';
import type { EntraCallbackService } from '../../services/entra-callback.service';

export interface AdminEntraCallbackRouteDeps {
  readonly entraCallback: EntraCallbackService;
  /** Session TTL seconds — for the Max-Age cookie attribute. From config. */
  readonly adminSessionTtlSeconds: number;
}

export interface AdminEntraCallbackRoute {
  /**
   * POST /api/v1/admin/auth/entra/callback — returns the contract response
   * plus the `Set-Cookie` header value for the adapter to set.
   */
  callback(
    body: unknown,
  ): Promise<AdminEntraCallbackResponse & { readonly setCookie: string }>;
}

export function createAdminEntraCallbackRoute(
  deps: AdminEntraCallbackRouteDeps,
): AdminEntraCallbackRoute {
  const { entraCallback, adminSessionTtlSeconds } = deps;

  return {
    async callback(body: unknown) {
      const result = await entraCallback.handleCallback(body);
      return {
        authenticated: result.authenticated,
        user: result.user,
        sessionToken: result.sessionToken,
        setCookie: buildSessionCookie(result.sessionToken, adminSessionTtlSeconds),
      };
    },
  };
}
