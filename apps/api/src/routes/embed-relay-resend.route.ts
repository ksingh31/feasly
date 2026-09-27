/**
 * Thin embed relay-resend route (embed/06 AC3). Routes are adapters, not
 * logic: validate input → call exactly one service method → return the
 * result.
 *
 * - Public by design: the iframe's "session expired" state calls this
 *   unauthenticated to re-issue a fresh relay code for an expired or
 *   already-used one. The presenter proves prior possession with the old
 *   code — no PII is needed or accepted.
 * - Abuse resistance: the standard public rate limiter on the request
 *   pipeline plus the service's own 60s-per-code cooldown (429) plus the
 *   code's single-use semantics.
 * - Denials are RFC 7807 410 (uniform — no oracle); cooldown is 429.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { EmbedRelayResendResponse } from '@feasly/contracts';
import type { EmbedRelayService } from '../services/embed-relay.service';

export interface EmbedRelayResendRouteDeps {
  readonly relayService: EmbedRelayService;
  /** Resolved by the function adapter from the request (x-forwarded-for). */
  readonly clientIp?: string;
}

export interface EmbedRelayResendRoute {
  /** Re-issue `{code, tenant_key}` → a fresh relay code. */
  handle(body: unknown, clientIp: string | undefined): Promise<EmbedRelayResendResponse>;
}

export function createEmbedRelayResendRoute(
  deps: EmbedRelayResendRouteDeps,
): EmbedRelayResendRoute {
  return {
    handle: async (body: unknown, clientIp: string | undefined): Promise<EmbedRelayResendResponse> => {
      return deps.relayService.resend(body, clientIp);
    },
  };
}
