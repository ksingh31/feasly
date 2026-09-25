/**
 * Thin admin estimate-lookup route (admin/03). Routes are adapters, not logic:
 * validate input → require admin → call exactly one service method.
 *
 * - `GET /api/v1/admin/estimates/{id}` — read-only estimate detail with
 *   snapshot timeline. Admin-gated via the session-cookie `AdminGuard`
 *   (admin/01).
 *
 * There is deliberately no PUT/PATCH/DELETE handler (AC3) — the Function
 * binding only allows GET/OPTIONS, so mutations never reach this code.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import type { AdminEstimateDetail } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { AdminEstimatesService } from '../services/admin-estimates.service';

export interface AdminEstimatesRouteDeps {
  readonly adminEstimates: AdminEstimatesService;
  readonly adminGuard: AdminGuard;
}

export interface AdminEstimatesRoute {
  /** GET /api/v1/admin/estimates/{id} */
  get(
    headers: Record<string, string | string[] | undefined>,
    id: unknown,
  ): Promise<AdminEstimateDetail>;
}

const estimateIdParamSchema = z.string().trim().uuid();

function parseEstimateId(id: unknown): string {
  const parsed = estimateIdParamSchema.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'Invalid estimate id.',
      false,
    );
  }
  return parsed.data;
}

export function createAdminEstimatesRoute(
  deps: AdminEstimatesRouteDeps,
): AdminEstimatesRoute {
  const { adminEstimates, adminGuard } = deps;

  return {
    async get(headers, id): Promise<AdminEstimateDetail> {
      await adminGuard.requireAdmin(headers);
      return adminEstimates.getEstimate(parseEstimateId(id));
    },
  };
}
