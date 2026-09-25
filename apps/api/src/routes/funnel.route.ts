/**
 * Thin funnel route (admin/07). Routes are adapters, not logic:
 * validate input → call exactly one service method → return the result.
 *
 * `GET /api/v1/admin/funnels?from=&to=&tenant_key=` — per-step funnel counts
 * + step-to-step conversion rates from the analytics events table.
 *
 * Query params:
 * - `from`, `to`: ISO-8601 dates (inclusive). Omitted = unbounded.
 * - `tenant_key`: omitted = all traffic; `direct` = Feasly-direct only
 *   (events with no tenant attribution); otherwise one embed tenant's key.
 *
 * Auth: admin only (via `AdminGuard`; interim X-Admin-Key until admin/01
 * lands). Numbers only — no PII in the response by construction.
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { FunnelReport, FunnelService } from '../services/funnel.service';
import type { FunnelTenantFilter } from '../services/funnel.store';

export interface FunnelRouteDeps {
  readonly funnel: FunnelService;
  readonly adminGuard: AdminGuard;
}

export interface FunnelRoute {
  /**
   * GET /api/v1/admin/funnels?from=&to=&tenant_key=
   */
  getFunnel(
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string | undefined>,
  ): Promise<FunnelReport>;
}

const querySchema = z.object({
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
  tenant_key: z.string().trim().min(1).max(100).optional(),
});

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Invalid ${name} date: expected ISO-8601.`,
      false,
    );
  }
  return d;
}

function parseTenantFilter(tenantKey: string | undefined): FunnelTenantFilter {
  if (!tenantKey) return { kind: 'all' };
  if (tenantKey === 'direct') return { kind: 'direct' };
  return { kind: 'tenant', tenantKey };
}

export function createFunnelRoute(deps: FunnelRouteDeps): FunnelRoute {
  const { funnel, adminGuard } = deps;

  return {
    async getFunnel(headers, query): Promise<FunnelReport> {
      await adminGuard.requireAdmin(headers);

      const parsed = querySchema.safeParse(query);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid funnel query parameters.',
          false,
        );
      }
      const from = parseDate(parsed.data.from, 'from');
      const to = parseDate(parsed.data.to, 'to');
      if (from && to && from > to) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid date range: from must not be after to.',
          false,
        );
      }

      return funnel.getFunnel({
        from,
        to,
        tenant: parseTenantFilter(parsed.data.tenant_key),
      });
    },
  };
}
