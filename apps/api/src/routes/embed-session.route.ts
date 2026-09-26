/**
 * Thin embed-session route (embed/06). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - Public by design: the iframe on a builder's page calls this
 *   unauthenticated to exchange its one-time relay code. Abuse resistance
 *   comes from the standard public rate limiter on the request pipeline
 *   plus the code's own single-use + 10-minute-expiry semantics.
 * - Denials are RFC 7807 410 (RELAY_CODE_INVALID) with a re-issue
 *   affordance in the detail — the frontend renders "session expired" with
 *   a one-tap "Email me a fresh link", never a dead end.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { EmbedSessionResponse } from '@feasly/contracts';
import type { EmbedRelayService } from '../services/embed-relay.service';

export interface EmbedSessionRouteDeps {
  readonly relayService: EmbedRelayService;
  /** Resolved by the function adapter from the request (x-forwarded-for). */
  readonly clientIp?: string;
}

export interface EmbedSessionRoute {
  /** Exchange `{code, tenant_key}` for a session token. */
  handle(body: unknown, clientIp: string | undefined): Promise<EmbedSessionResponse>;
}

export function createEmbedSessionRoute(
  deps: EmbedSessionRouteDeps,
): EmbedSessionRoute {
  return {
    handle: async (body: unknown, clientIp: string | undefined): Promise<EmbedSessionResponse> => {
      return deps.relayService.exchange(body, clientIp);
    },
  };
}
