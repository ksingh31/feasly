/**
 * Funnel persistence boundary (story admin/07).
 *
 * The funnel dashboard aggregates the append-only `analytics_events` table
 * (consumer/01). This store exposes exactly one read: counts grouped by
 * (event, route) inside a date range, with an optional tenant filter.
 * Sandbox rows (`sandbox = true`, api-mcp/09 test data) are always excluded —
 * they are not real user behavior.
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { and, count, eq, gte, isNull, lte } from 'drizzle-orm';
import { analyticsEvents } from '../db/schema';

export type FunnelTenantFilter =
  /** No tenant filter — all events. */
  | { readonly kind: 'all' }
  /** Feasly-direct traffic only (`tenant_key IS NULL`). */
  | { readonly kind: 'direct' }
  /** One embed tenant's events. */
  | { readonly kind: 'tenant'; readonly tenantKey: string };

export interface FunnelCountQuery {
  readonly from?: Date;
  readonly to?: Date;
  readonly tenant: FunnelTenantFilter;
}

/** Raw grouped count — the service maps (event, route) onto funnel steps. */
export interface EventRouteCount {
  readonly event: string;
  readonly route: string;
  readonly count: number;
}

export interface FunnelStore {
  /**
   * Counts of non-sandbox events grouped by (event, route) inside the
   * optional date range, honoring the tenant filter.
   */
  countByEventRoute(query: FunnelCountQuery): Promise<readonly EventRouteCount[]>;
}

export interface DrizzleFunnelStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleFunnelStore(
  deps: DrizzleFunnelStoreDeps,
): FunnelStore {
  const { db } = deps;

  return {
    async countByEventRoute(
      query: FunnelCountQuery,
    ): Promise<readonly EventRouteCount[]> {
      const conditions = [eq(analyticsEvents.sandbox, false)];
      if (query.from) {
        conditions.push(gte(analyticsEvents.createdAt, query.from));
      }
      if (query.to) {
        conditions.push(lte(analyticsEvents.createdAt, query.to));
      }
      switch (query.tenant.kind) {
        case 'direct':
          conditions.push(isNull(analyticsEvents.tenantKey));
          break;
        case 'tenant':
          conditions.push(eq(analyticsEvents.tenantKey, query.tenant.tenantKey));
          break;
        case 'all':
          break;
      }

      const rows = await db
        .select({
          event: analyticsEvents.event,
          route: analyticsEvents.route,
          count: count(),
        })
        .from(analyticsEvents)
        .where(and(...conditions))
        .groupBy(analyticsEvents.event, analyticsEvents.route);

      return rows.map((r: { event: string; route: string; count: number }) => ({
        event: r.event,
        route: r.route,
        count: Number(r.count),
      }));
    },
  };
}
