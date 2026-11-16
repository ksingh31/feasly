/**
 * Funnel persistence boundary (story admin/07).
 *
 * The funnel dashboard aggregates the append-only `analytics_events` table
 * (consumer/01). This store exposes exactly one read: counts grouped by
 * (event, route, utm_source, utm_campaign) inside a date range, with
 * optional tenant and source/campaign filters (#814).
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
  /** #814: only events with this exact utm_source. Omitted = any. */
  readonly utmSource?: string;
  /** #814: only events with this exact utm_campaign. Omitted = any. */
  readonly utmCampaign?: string;
}

/**
 * Raw grouped count — the service maps (event, route) onto funnel steps and
 * (utmSource, utmCampaign) onto the per-source breakdown. The utm fields
 * are optional so callers/fakes without attribution read as unattributed.
 */
export interface EventRouteCount {
  readonly event: string;
  readonly route: string;
  readonly utmSource?: string | null;
  readonly utmCampaign?: string | null;
  readonly count: number;
}

export interface FunnelStore {
  /**
   * Counts of non-sandbox events grouped by (event, route, utm_source,
   * utm_campaign) inside the optional date range, honoring the tenant and
   * source/campaign filters.
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
      if (query.utmSource !== undefined) {
        conditions.push(eq(analyticsEvents.utmSource, query.utmSource));
      }
      if (query.utmCampaign !== undefined) {
        conditions.push(eq(analyticsEvents.utmCampaign, query.utmCampaign));
      }

      const rows = await db
        .select({
          event: analyticsEvents.event,
          route: analyticsEvents.route,
          utmSource: analyticsEvents.utmSource,
          utmCampaign: analyticsEvents.utmCampaign,
          count: count(),
        })
        .from(analyticsEvents)
        .where(and(...conditions))
        .groupBy(
          analyticsEvents.event,
          analyticsEvents.route,
          analyticsEvents.utmSource,
          analyticsEvents.utmCampaign,
        );

      return rows.map(
        (r: {
          event: string;
          route: string;
          utmSource: string | null;
          utmCampaign: string | null;
          count: number;
        }) => ({
          event: r.event,
          route: r.route,
          utmSource: r.utmSource,
          utmCampaign: r.utmCampaign,
          count: Number(r.count),
        }),
      );
    },
  };
}
