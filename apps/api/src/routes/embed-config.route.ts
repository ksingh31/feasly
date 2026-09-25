/**
 * Thin embed-config route (EMB-02). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * - Public by design: the embed shell on a builder's site calls this
 *   unauthenticated at load. Abuse resistance comes from the standard
 *   public rate limiter on the request pipeline (see composition.ts).
 * - `?key=` names the tenant (`config/builders/{key}.json`); unknown keys
 *   get RFC 7807 404 UNKNOWN_TENANT so the embed shell can show its
 *   fallback card.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type { EmbedPublicConfig } from '@feasly/contracts';
import type { BuilderConfigService } from '../services/builder-config.service';
import { HttpError, ErrorCodes } from '../middleware/errors';

const QuerySchema = z.object({
  key: z.string().min(1).max(100),
});

export interface EmbedConfigRouteDeps {
  readonly builderConfig: BuilderConfigService;
}

export interface EmbedConfigRoute {
  /** Resolve the public config for `?key=`. */
  handle(query: unknown): Promise<EmbedPublicConfig>;
}

export function createEmbedConfigRoute(
  deps: EmbedConfigRouteDeps,
): EmbedConfigRoute {
  return {
    handle: async (query: unknown): Promise<EmbedPublicConfig> => {
      const parsed = QuerySchema.safeParse(query ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Query parameter "key" is required',
        );
      }
      return deps.builderConfig.getByKey(parsed.data.key);
    },
  };
}
