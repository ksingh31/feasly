/**
 * Thin waitlist route (#520). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * Fully public — the Function adapter applies the PII-class rate limiter.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { WaitlistResponse } from '@feasly/contracts';
import type { WaitlistService } from '../services/waitlist.service';

export interface WaitlistRouteDeps {
  readonly waitlist: WaitlistService;
}

export interface WaitlistRoute {
  /** Records a waitlist signup on an untrusted request body. */
  handle(requestBody: unknown): Promise<WaitlistResponse>;
}

export function createWaitlistRoute(deps: WaitlistRouteDeps): WaitlistRoute {
  return {
    handle: (requestBody: unknown): Promise<WaitlistResponse> => deps.waitlist.join(requestBody),
  };
}
