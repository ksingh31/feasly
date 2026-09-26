/**
 * Thin callback route (phase-2 wiring). Routes are adapters, not logic:
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
import type { CallbackResponse } from '@feasly/contracts';
import type { CallbackService } from '../services/callback.service';

export interface CallbackRouteDeps {
  readonly callbacks: CallbackService;
}

export interface CallbackRoute {
  /** Records a callback request on an untrusted request body. */
  handle(requestBody: unknown): Promise<CallbackResponse>;
}

export function createCallbackRoute(deps: CallbackRouteDeps): CallbackRoute {
  return {
    handle: (requestBody: unknown): Promise<CallbackResponse> =>
      deps.callbacks.requestCallback(requestBody),
  };
}
