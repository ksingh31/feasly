/**
 * Funnel aggregation service (story admin/07).
 *
 * Computes Karan's conversion funnel from the append-only `analytics_events`
 * table: per-step counts plus step-to-step conversion rates over a date
 * range, optionally filtered to one tenant (or Feasly-direct only).
 *
 * The step definitions mirror the real client instrumentation
 * (`apps/web/.../analytics-tracker.service.ts`), not the story's aspirational
 * text: `/` (landing) is deliberately unmapped client-side because it doubles
 * as the marketing homepage, so the measured funnel starts at the scope step;
 * there is a details step the story text didn't name. Any future route or
 * event rename must update FUNNEL_STEPS here — the service test pins the
 * table to the tracker's ROUTE_ANALYTICS map.
 *
 * PII discipline: the response carries step ids, labels, counts, and rates
 * only. Event rows never leave the store boundary — the service aggregates
 * in the database and returns numbers.
 */
import type { AnalyticsEventName } from '@feasly/contracts';
import type {
  EventRouteCount,
  FunnelCountQuery,
  FunnelStore,
  FunnelTenantFilter,
} from './funnel.store';

export interface FunnelStepDef {
  readonly id: 'scope' | 'details' | 'preview' | 'gate' | 'report';
  readonly label: string;
  readonly event: AnalyticsEventName;
  /** Client routes that count toward this step. */
  readonly routes: readonly string[];
}

/**
 * The canonical funnel, in order. `scope` merges the new-build and reno
 * scope steps — they are the same funnel position.
 */
export const FUNNEL_STEPS: readonly FunnelStepDef[] = [
  {
    id: 'scope',
    label: 'Scope',
    event: 'step_view',
    routes: ['/estimate/scope', '/estimate/reno-scope'],
  },
  {
    id: 'details',
    label: 'Details',
    event: 'step_view',
    routes: ['/estimate/details'],
  },
  {
    id: 'preview',
    label: 'Preview',
    event: 'step_view',
    routes: ['/estimate/preview'],
  },
  {
    id: 'gate',
    label: 'Gate',
    event: 'gate_view',
    routes: ['/estimate/gate'],
  },
  {
    id: 'report',
    label: 'Report',
    event: 'report_open',
    routes: ['/estimate/report'],
  },
];

export interface FunnelQuery {
  readonly from?: Date;
  readonly to?: Date;
  readonly tenant: FunnelTenantFilter;
}

export interface FunnelStepResult {
  readonly step: string;
  readonly label: string;
  readonly count: number;
  /**
   * count(step) / count(previous step), rounded to 4 decimals.
   * null for the first step, or when the previous step's count is 0
   * (a rate would be meaningless, not zero).
   */
  readonly conversionFromPrevious: number | null;
}

export interface FunnelReport {
  readonly from: string | null;
  readonly to: string | null;
  readonly tenant: string;
  readonly steps: readonly FunnelStepResult[];
}

export interface FunnelService {
  /**
   * Aggregate the funnel for the query. Throws nothing for empty data —
   * an empty range returns zero counts (the dashboard renders an empty
   * state, never an error).
   */
  getFunnel(query: FunnelQuery): Promise<FunnelReport>;
}

export interface FunnelServiceDeps {
  readonly store: FunnelStore;
}

export function tenantFilterLabel(tenant: FunnelTenantFilter): string {
  switch (tenant.kind) {
    case 'all':
      return 'all';
    case 'direct':
      return 'direct';
    case 'tenant':
      return tenant.tenantKey;
  }
}

export function createFunnelService(deps: FunnelServiceDeps): FunnelService {
  const { store } = deps;

  return {
    async getFunnel(query: FunnelQuery): Promise<FunnelReport> {
      const counts = await store.countByEventRoute({
        from: query.from,
        to: query.to,
        tenant: query.tenant,
      } satisfies FunnelCountQuery);

      // Index grouped counts by `event␟route` for O(1) step lookup.
      const byEventRoute = new Map<string, number>();
      for (const row of counts satisfies readonly EventRouteCount[]) {
        byEventRoute.set(`${row.event} ${row.route}`, row.count);
      }

      const steps: FunnelStepResult[] = [];
      let previousCount: number | null = null;
      for (const def of FUNNEL_STEPS) {
        let stepCount = 0;
        for (const route of def.routes) {
          stepCount += byEventRoute.get(`${def.event} ${route}`) ?? 0;
        }
        const conversionFromPrevious =
          previousCount === null || previousCount === 0
            ? null
            : Math.round((stepCount / previousCount) * 10000) / 10000;
        steps.push({
          step: def.id,
          label: def.label,
          count: stepCount,
          conversionFromPrevious,
        });
        previousCount = stepCount;
      }

      return {
        from: query.from ? query.from.toISOString() : null,
        to: query.to ? query.to.toISOString() : null,
        tenant: tenantFilterLabel(query.tenant),
        steps,
      };
    },
  };
}
