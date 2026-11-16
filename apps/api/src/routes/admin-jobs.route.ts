/**
 * Thin admin job-queue route (#838).
 * Routes are adapters, not logic: enforce the admin guard → validate the
 * query → call exactly one service method → return the result.
 *
 * - GET /api/v1/admin/ops/jobs?status=dead&limit=50 — admin-gated
 *   (`ops:manage`). Per-status counts plus the latest jobs in one status;
 *   default `dead` = the failed jobs that exhausted their retries.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import type { AdminJobsResponse } from '@feasly/contracts';
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { JobQueueService } from '../services/job-queue.service';

export interface AdminJobsRouteDeps {
  readonly jobs: Pick<JobQueueService, 'listJobs'>;
  readonly adminGuard: AdminGuard;
}

export interface AdminJobsRoute {
  /** GET /api/v1/admin/ops/jobs */
  list(
    headers: Record<string, string | string[] | undefined>,
    query: unknown,
  ): Promise<AdminJobsResponse>;
}

const querySchema = z.object({
  status: z.enum(['pending', 'running', 'done', 'dead', 'cancelled']).default('dead'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function createAdminJobsRoute(deps: AdminJobsRouteDeps): AdminJobsRoute {
  return {
    async list(headers, query): Promise<AdminJobsResponse> {
      await deps.adminGuard.requireAdmin(headers);
      const parsed = querySchema.safeParse(query ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          parsed.error.issues[0]?.message ?? 'Invalid jobs query.',
          false,
        );
      }
      return deps.jobs.listJobs(parsed.data);
    },
  };
}
