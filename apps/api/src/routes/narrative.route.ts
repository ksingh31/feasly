/**
 * Thin narrative route (consumer/06). Routes are adapters, not logic:
 * extract the bearer token from headers → call exactly one service
 * method → return the result.
 *
 * - POST /api/v1/estimates/{id}/narrative → generateNarrative
 *
 * Authenticated by magic-link bearer token (the service owns verification).
 * Runs inside the BE0-003 request pipeline via the Azure Functions trigger
 * adapters (`src/functions/narrative.ts`).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { NarrativeResponse } from '@feasly/contracts';
import type { NarrativeService } from '../services/narrative.service';
import { extractBearerToken } from './privacy.route';

export interface NarrativeRequestHeaders {
  readonly authorization?: string | string[] | undefined;
}

export interface NarrativeRouteDeps {
  readonly narrative: NarrativeService;
}

export interface NarrativeRoute {
  generateNarrative(
    headers: NarrativeRequestHeaders,
    estimateId: string,
  ): Promise<NarrativeResponse>;
}

export function createNarrativeRoute(deps: NarrativeRouteDeps): NarrativeRoute {
  return {
    generateNarrative: (headers, estimateId) =>
      deps.narrative.generateNarrative(extractBearerToken(headers), estimateId),
  };
}
