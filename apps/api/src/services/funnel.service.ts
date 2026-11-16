/**
 * Funnel aggregation service (story admin/07, top of funnel + campaign
 * breakdown #814).
 *
 * Computes Karan's conversion funnel from the append-only `analytics_events`
 * table: per-step counts plus step-to-step conversion rates over a date
 * range, optionally filtered to one tenant (or Feasly-direct only) and to
 * one utm_source / utm_campaign, plus a per-(source, campaign) breakdown.
 *
 * Steps (#814): landing view → address selected → preview → gate view →
 * gate convert → report open. The top-of-funnel events are fired by the web
 * client from the pages themselves (#815), so they count on any route.
 * The preview step also counts the legacy `step_view` on /estimate/preview
 * (the route-tracker event before `preview_view` existed) so history stays
 * comparable; clients send one or the other, never both. The scope step
 * was dropped from the funnel in #814 (its `step_view` rows are ignored).
 * Any future route or event rename must update FUNNEL_STEPS — the service
 * test pins the route-bound matchers to the tracker's ROUTE_ANALYTICS map.
 *
 * PII discipline: the response carries step ids, labels, counts, rates and
 * the (length-capped, PII-free charset) utm_source / utm_campaign values
 * only. Event rows never leave the store boundary.
 */
import type { AnalyticsEventName } from '@feasly/contracts';
import type {
  EventRouteCount,
  FunnelCountQuery,
  FunnelStore,
  FunnelTenantFilter,
} from './funnel.store';

/** One way an analytics event counts toward a step. */
export interface FunnelStepMatcher {
  readonly event: AnalyticsEventName;
  /** Client routes that count. Omitted = the event counts on any route. */
  readonly routes?: readonly string[];
}

export interface FunnelStepDef {
  readonly id:
    | 'landing'
    | 'address'
    | 'preview'
    | 'gate'
    | 'convert'
    | 'report';
  readonly label: string;
  readonly matchers: readonly FunnelStepMatcher[];
}

/** The canonical funnel, in order. */
export const FUNNEL_STEPS: readonly FunnelStepDef[] = [
  {
    id: 'landing',
    label: 'Landing view',
    matchers: [{ event: 'landing_view' }],
  },
  {
    id: 'address',
    label: 'Address selected',
    matchers: [{ event: 'address_selected' }],
  },
  {
    id: 'preview',
    label: 'Preview',
    matchers: [
      { event: 'preview_view' },
      { event: 'step_view', routes: ['/estimate/preview'] },
    ],
  },
  {
    id: 'gate',
    label: 'Gate view',
    matchers: [{ event: 'gate_view', routes: ['/estimate/gate'] }],
  },
  {
    id: 'convert',
    label: 'Gate convert',
    matchers: [{ event: 'gate_convert' }],
  },
  {
    id: 'report',
    label: 'Report open',
    matchers: [{ event: 'report_open', routes: ['/estimate/report'] }],
  },
];

export interface FunnelQuery {
  readonly from?: Date;
  readonly to?: Date;
  readonly tenant: FunnelTenantFilter;
  /** #814: exact utm_source filter. Omitted = any. */
  readonly utmSource?: string;
  /** #814: exact utm_campaign filter. Omitted = any. */
  readonly utmCampaign?: string;
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

/**
 * #814: the funnel for one (utm_source, utm_campaign) pair. null means
 * the event carried no value for that field (direct / untagged traffic).
 */
export interface FunnelSourceGroup {
  readonly utmSource: string | null;
  readonly utmCampaign: string | null;
  readonly steps: readonly FunnelStepResult[];
}

export interface FunnelReport {
  readonly from: string | null;
  readonly to: string | null;
  readonly tenant: string;
  /** #814: echo of the utm_source filter (null = not filtered). */
  readonly utmSource: string | null;
  /** #814: echo of the utm_campaign filter (null = not filtered). */
  readonly utmCampaign: string | null;
  readonly steps: readonly FunnelStepResult[];
  /**
   * #814: the same funnel grouped by (utm_source, utm_campaign), largest
   * groups first (by total step count, ties by source then campaign), at
   * most `sourceGroupLimit` groups. Groups with no funnel-step events are
   * omitted.
   */
  readonly bySource: readonly FunnelSourceGroup[];
  /** True when more groups existed than `sourceGroupLimit`. */
  readonly bySourceTruncated: boolean;
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
  /** Max groups in `bySource` (config `FUNNEL_SOURCE_GROUP_LIMIT`). */
  readonly sourceGroupLimit: number;
}

/** Sum each step's matching counts and compute step-to-step conversion. */
function computeSteps(rows: readonly EventRouteCount[]): FunnelStepResult[] {
  const steps: FunnelStepResult[] = [];
  let previousCount: number | null = null;
  for (const def of FUNNEL_STEPS) {
    let stepCount = 0;
    for (const row of rows) {
      const matches = def.matchers.some(
        (m) =>
          m.event === row.event &&
          (m.routes === undefined || m.routes.includes(row.route)),
      );
      if (matches) stepCount += row.count;
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
  return steps;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // untagged sorts after tagged on ties
  if (b === null) return -1;
  return a < b ? -1 : 1;
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
  const { store, sourceGroupLimit } = deps;

  return {
    async getFunnel(query: FunnelQuery): Promise<FunnelReport> {
      const counts = await store.countByEventRoute({
        from: query.from,
        to: query.to,
        tenant: query.tenant,
        ...(query.utmSource !== undefined ? { utmSource: query.utmSource } : {}),
        ...(query.utmCampaign !== undefined
          ? { utmCampaign: query.utmCampaign }
          : {}),
      } satisfies FunnelCountQuery);

      // Bucket rows by (utm_source, utm_campaign) for the breakdown.
      const buckets = new Map<
        string,
        { utmSource: string | null; utmCampaign: string | null; rows: EventRouteCount[] }
      >();
      for (const row of counts) {
        const utmSource = row.utmSource ?? null;
        const utmCampaign = row.utmCampaign ?? null;
        const key = JSON.stringify([utmSource, utmCampaign]);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { utmSource, utmCampaign, rows: [] };
          buckets.set(key, bucket);
        }
        bucket.rows.push(row);
      }

      const groups = [...buckets.values()]
        .map((b) => {
          const steps = computeSteps(b.rows);
          const total = steps.reduce((sum, st) => sum + st.count, 0);
          return { utmSource: b.utmSource, utmCampaign: b.utmCampaign, steps, total };
        })
        .filter((g) => g.total > 0)
        .sort(
          (a, b) =>
            b.total - a.total ||
            compareNullable(a.utmSource, b.utmSource) ||
            compareNullable(a.utmCampaign, b.utmCampaign),
        );

      return {
        from: query.from ? query.from.toISOString() : null,
        to: query.to ? query.to.toISOString() : null,
        tenant: tenantFilterLabel(query.tenant),
        utmSource: query.utmSource ?? null,
        utmCampaign: query.utmCampaign ?? null,
        steps: computeSteps(counts),
        bySource: groups.slice(0, sourceGroupLimit).map((g) => ({
          utmSource: g.utmSource,
          utmCampaign: g.utmCampaign,
          steps: g.steps,
        })),
        bySourceTruncated: groups.length > sourceGroupLimit,
      };
    },
  };
}
