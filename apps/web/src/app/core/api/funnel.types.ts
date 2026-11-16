/**
 * Funnel dashboard types (admin/07 frontend).
 *
 * Mirrors the backend `FunnelReport` shape from
 * `apps/api/src/services/funnel.service.ts` (`GET /api/v1/admin/funnels`).
 * The backend is the contract owner; these are the client's view of the
 * same JSON. Numbers only — no PII ever flows through these types.
 */

/** One funnel step: id, display label, visitor count, step-to-step conversion. */
export interface FunnelStep {
  readonly step: string;
  readonly label: string;
  readonly count: number;
  /**
   * count(step) / count(previous step), 0–1 scale.
   * null for the first step or when the previous step's count is 0.
   */
  readonly conversionFromPrevious: number | null;
}

/**
 * #814/#815: the funnel for one (utm_source, utm_campaign) pair. null =
 * events without that field (direct traffic or untagged campaigns).
 */
export interface FunnelSourceGroup {
  readonly utmSource: string | null;
  readonly utmCampaign: string | null;
  readonly steps: readonly FunnelStep[];
}

/** Full funnel report for a date range + tenant filter. */
export interface FunnelReport {
  readonly from: string | null;
  readonly to: string | null;
  /** 'all' | 'direct' | the tenant key that was queried. */
  readonly tenant: string;
  /** #814: echo of the utm_source filter (null = not filtered). Optional for pre-#814 backends. */
  readonly utmSource?: string | null;
  /** #814: echo of the utm_campaign filter (null = not filtered). */
  readonly utmCampaign?: string | null;
  readonly steps: readonly FunnelStep[];
  /** #814: the same funnel per (source, campaign), largest first, capped. */
  readonly bySource?: readonly FunnelSourceGroup[];
  /** True when more groups existed than the backend's cap. */
  readonly bySourceTruncated?: boolean;
}

/** Tenant filter for the funnel query. */
export type FunnelTenantFilter = 'all' | 'direct' | string;

/** Query sent to `GET /api/v1/admin/funnels`. */
export interface FunnelQuery {
  /** Inclusive start, YYYY-MM-DD. Omitted = unbounded. */
  readonly from?: string;
  /** Inclusive end, YYYY-MM-DD. Omitted = unbounded. */
  readonly to?: string;
  /** 'all' = every tenant, 'direct' = Feasly-direct only, else one tenant key. */
  readonly tenant: FunnelTenantFilter;
  /** #815: exact utm_source filter. Omitted = any. */
  readonly utmSource?: string;
  /** #815: exact utm_campaign filter. Omitted = any. */
  readonly utmCampaign?: string;
}
