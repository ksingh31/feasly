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
import type {
  PartnerShareResponse,
  PartnerShareVerifyResponse,
} from '@feasly/contracts';
import { z } from 'zod';
import type { ShareService } from '../services/share.service';

export interface ShareRouteDeps {
  readonly shares: ShareService;
}

export interface ShareRoute {
  /** Shares a report with a partner on an untrusted request body. */
  handle(requestBody: unknown): Promise<PartnerShareResponse>;
  /**
   * GET /api/v1/shares/verify?token=… — verifies a partner-share link
   * token. Partner tokens only; anything else answers invalid.
   */
  verify(query: unknown): Promise<PartnerShareVerifyResponse>;
}

const verifyQuerySchema = z.object({
  token: z.string().trim().min(1).max(500),
});

export function createShareRoute(deps: ShareRouteDeps): ShareRoute {
  return {
    handle: (requestBody: unknown): Promise<PartnerShareResponse> =>
      deps.shares.shareWithPartner(requestBody),
    verify: (query: unknown): Promise<PartnerShareVerifyResponse> => {
      const parsed = verifyQuerySchema.safeParse(query);
      if (!parsed.success) {
        // Unknown token: same denial shape as an invalid one, no oracle.
        return Promise.resolve({ valid: false, reason: 'invalid' });
      }
      return deps.shares.verifyPartnerLink(parsed.data.token);
    },
  };
}
