/**
 * Thin magic-link route (consumer/02). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - `verify`: public by token possession — the token IS the credential.
 *   The query param is validated (non-empty string) and nothing else;
 *   the service decides validity without an existence oracle.
 * - `reissue`: public by design ("resend my link"). Abuse resistance comes
 *   from the pipeline rate limiter, not auth. Unknown emails return the
 *   same `{ sent: false }` shape — no address enumeration.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  MagicLinkReissueResponse,
  MagicLinkVerifyResponse,
} from '@feasly/contracts';
import type { MagicLinkService } from '../services/magic-link.service';

export interface MagicLinkRouteDeps {
  readonly magicLinks: MagicLinkService;
}

export interface MagicLinkRoute {
  /** GET /api/v1/magic-link/verify?token=… — resolves the token to a report. */
  verify(query: unknown): Promise<MagicLinkVerifyResponse>;
  /** POST /api/v1/magic-link/reissue — idempotent link resend. */
  reissue(requestBody: unknown): Promise<MagicLinkReissueResponse>;
}

const verifyQuerySchema = z.object({
  token: z.string().trim().min(1).max(500),
});

export function createMagicLinkRoute(deps: MagicLinkRouteDeps): MagicLinkRoute {
  return {
    verify: (query: unknown): Promise<MagicLinkVerifyResponse> => {
      const parsed = verifyQuerySchema.safeParse(query);
      if (!parsed.success) {
        // Unknown token: same denial shape as an invalid one, no oracle.
        return Promise.resolve({
          valid: false,
          reason: 'invalid',
          reissueAllowed: true,
        });
      }
      return deps.magicLinks.verify(parsed.data.token);
    },
    reissue: (requestBody: unknown): Promise<MagicLinkReissueResponse> =>
      deps.magicLinks.reissue(requestBody),
  };
}
