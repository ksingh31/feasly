/**
 * Thin lead-gate route (BE3-003). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - Public by design: callers are unauthenticated by definition (this is the
 *   gate). Abuse resistance comes from the dedicated tight rate limiter on
 *   the lead pipeline (see composition.ts), not from auth.
 * - Runs inside the BE0-003 request pipeline (correlation + rate limiting +
 *   RFC 7807 errors) via the Azure Functions trigger adapter
 *   (`src/functions/leads.ts` → POST /api/v1/leads).
 * - Duplicate POSTs (same email + address inside the dedup window) return
 *   the existing lead — the service owns that decision, not the route.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { LeadResponse } from '@feasly/contracts';
import type { LeadService } from '../services/lead.service';

export interface LeadRouteDeps {
  readonly leads: LeadService;
}

export interface LeadRoute {
  /** Captures one lead from an untrusted request body. */
  handle(requestBody: unknown): Promise<LeadResponse>;
}

export function createLeadRoute(deps: LeadRouteDeps): LeadRoute {
  return {
    handle: (requestBody: unknown): Promise<LeadResponse> =>
      deps.leads.submitLead(requestBody),
  };
}
