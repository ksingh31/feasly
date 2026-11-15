/**
 * Thin admin global-search route (⌘K palette). Routes are adapters, not
 * logic: permission check → validate input → call exactly one service
 * method → return the result.
 *
 * - `GET /api/v1/admin/search?q=` — typed hits (leads, invoices, builders,
 *   users) with display labels and IDs. Feasly staff only (`leads:read`,
 *   which no builder role holds) → builder roles get 403. Which kinds a
 *   caller sees is decided per permission inside AdminSearchService.
 *   Rate-limited per IP, then per admin session, by the dedicated
 *   adminSearchPipeline.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type { AdminSearchResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { PermissionGuard } from '../middleware/permission-guard';
import type { AdminSearchService } from '../services/admin-search.service';

export interface AdminSearchRouteDeps {
  readonly search: AdminSearchService;
  readonly permissionGuard: Pick<PermissionGuard, 'requirePermission'>;
}

export interface AdminSearchRoute {
  /** GET /api/v1/admin/search */
  search(
    headers: Record<string, string | string[] | undefined>,
    query: unknown,
  ): Promise<AdminSearchResponse>;
}

/** Max query length — a palette query, not a document. */
export const ADMIN_SEARCH_MAX_QUERY_LENGTH = 100;

const querySchema = z.object({
  q: z.string().trim().min(1).max(ADMIN_SEARCH_MAX_QUERY_LENGTH),
});

export function createAdminSearchRoute(deps: AdminSearchRouteDeps): AdminSearchRoute {
  const { search, permissionGuard } = deps;

  return {
    async search(headers, query): Promise<AdminSearchResponse> {
      // Authorize before validating so an unauthenticated / builder caller
      // learns nothing about the endpoint's input rules.
      const ctx = await permissionGuard.requirePermission(
        'leads:read',
        headers,
        'GET /api/v1/admin/search',
      );
      const raw = (query ?? {}) as Record<string, unknown>;
      const q = Array.isArray(raw['q']) ? raw['q'][0] : raw['q'];
      const parsed = querySchema.safeParse({ q });
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          `Query "q" is required (1–${ADMIN_SEARCH_MAX_QUERY_LENGTH} characters).`,
          false,
        );
      }
      const hits = await search.search(parsed.data.q, ctx.permissions);
      return { query: parsed.data.q, hits };
    },
  };
}
