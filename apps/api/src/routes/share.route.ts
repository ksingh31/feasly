/**
 * Thin partner-share route (phase-2 wiring). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * Public-token endpoint (the magic-link report token is the credential) —
 * the Function adapter applies the public rate limiter.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { PartnerShareResponse } from '@feasly/contracts';
import type { ShareService } from '../services/share.service';

export interface ShareRouteDeps {
  readonly shares: ShareService;
}

export interface ShareRoute {
  /** Shares a report with a partner on an untrusted request body. */
  handle(requestBody: unknown): Promise<PartnerShareResponse>;
}

export function createShareRoute(deps: ShareRouteDeps): ShareRoute {
  return {
    handle: (requestBody: unknown): Promise<PartnerShareResponse> =>
      deps.shares.shareWithPartner(requestBody),
  };
}
