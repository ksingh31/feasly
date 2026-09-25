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

/** Full funnel report for a date range + tenant filter. */
export interface FunnelReport {
  readonly from: string | null;
  readonly to: string | null;
  /** 'all' | 'direct' | the tenant key that was queried. */
  readonly tenant: string;
  readonly steps: readonly FunnelStep[];
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
}
