/**
 * Thin unsubscribe route (email/03). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - `getState`: public by token possession — the token IS the credential.
 *   Read-only; the frontend renders the confirmation page from the state.
 * - `unsubscribe`: public by token possession; records the opt-out.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type {
  UnsubscribeResultResponse,
  UnsubscribeStateResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { UnsubscribeService } from '../services/unsubscribe.service';

export interface UnsubscribeRouteDeps {
  readonly unsubscribe: UnsubscribeService;
}

export interface UnsubscribeRoute {
  /** GET /api/v1/unsubscribe/{token} — confirmation-page state (read-only). */
  getState(token: unknown): Promise<UnsubscribeStateResponse>;
  /** POST /api/v1/unsubscribe/{token} — record the opt-out (idempotent). */
  unsubscribe(token: unknown): Promise<UnsubscribeResultResponse>;
}

const tokenParamSchema = z.string().trim().min(1).max(500);

function invalidToken(): HttpError {
  // Same 403 shape the service returns for forged tokens — no oracle.
  return new HttpError(
    403,
    ErrorCodes.FORBIDDEN,
    'This unsubscribe link is not valid.',
  );
}

export function createUnsubscribeRoute(
  deps: UnsubscribeRouteDeps,
): UnsubscribeRoute {
  return {
    getState: (token: unknown): Promise<UnsubscribeStateResponse> => {
      const parsed = tokenParamSchema.safeParse(token);
      if (!parsed.success) {
        return Promise.reject(invalidToken());
      }
      return deps.unsubscribe.getState(parsed.data);
    },
    unsubscribe: (token: unknown): Promise<UnsubscribeResultResponse> => {
      const parsed = tokenParamSchema.safeParse(token);
      if (!parsed.success) {
        return Promise.reject(invalidToken());
      }
      return deps.unsubscribe.unsubscribe(parsed.data);
    },
  };
}
