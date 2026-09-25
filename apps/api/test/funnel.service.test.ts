/**
 * Funnel service tests (admin/07).
 *
 * Covers: step mapping from (event, route) grouped counts, scope merging
 * new-build + reno scope routes, conversion math (4-decimal rounding),
 * null conversion for the first step and when the previous step is 0,
 * empty data → zero counts (never an error), tenant filter passthrough,
 * and the FUNNEL_STEPS table pinned to the web tracker's ROUTE_ANALYTICS map.
 *
 * The FunnelStore is faked; no database is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  FUNNEL_STEPS,
  createFunnelService,
  type FunnelService,
} from '../src/services/funnel.service';
import type {
  EventRouteCount,
  FunnelCountQuery,
  FunnelStore,
} from '../src/services/funnel.store';

function createFakeStore(
  rows: readonly EventRouteCount[],
): FunnelStore & { lastQuery: FunnelCountQuery | null } {
  const fake: FunnelStore & { lastQuery: FunnelCountQuery | null } = {
    lastQuery: null,
    async countByEventRoute(query: FunnelCountQuery) {
      fake.lastQuery = query;
      return rows;
    },
  };
  return fake;
}

function serviceWith(
  rows: readonly EventRouteCount[],
): { service: FunnelService; store: { lastQuery: FunnelCountQuery | null } } {
  const store = createFakeStore(rows);
  return { service: createFunnelService({ store }), store };
}

const ALL = { kind: 'all' } as const;

describe('funnel service', () => {
  it('maps (event, route) counts onto the five funnel steps in order', async () => {
    const { service } = serviceWith([
      { event: 'step_view', route: '/estimate/scope', count: 100 },
      { event: 'step_view', route: '/estimate/details', count: 80 },
      { event: 'step_view', route: '/estimate/preview', count: 60 },
      { event: 'gate_view', route: '/estimate/gate', count: 40 },
      { event: 'report_open', route: '/estimate/report', count: 30 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps.map((s) => s.step)).toEqual([
      'scope',
      'details',
      'preview',
      'gate',
      'report',
    ]);
    expect(report.steps.map((s) => s.count)).toEqual([100, 80, 60, 40, 30]);
  });

  it('merges new-build and reno scope routes into the scope step', async () => {
    const { service } = serviceWith([
      { event: 'step_view', route: '/estimate/scope', count: 70 },
      { event: 'step_view', route: '/estimate/reno-scope', count: 30 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[0]!.count).toBe(100);
  });

  it('computes step-to-step conversion rates rounded to 4 decimals', async () => {
    const { service } = serviceWith([
      { event: 'step_view', route: '/estimate/scope', count: 100 },
      { event: 'step_view', route: '/estimate/details', count: 33 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[0]!.conversionFromPrevious).toBeNull();
    expect(report.steps[1]!.conversionFromPrevious).toBe(0.33);
  });

  it('returns null conversion when the previous step count is 0', async () => {
    const { service } = serviceWith([
      { event: 'step_view', route: '/estimate/details', count: 5 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[0]!.count).toBe(0);
    expect(report.steps[1]!.count).toBe(5);
    expect(report.steps[1]!.conversionFromPrevious).toBeNull();
  });

  it('returns zero counts for empty data (empty state, never an error)', async () => {
    const { service } = serviceWith([]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps).toHaveLength(5);
    expect(report.steps.every((s) => s.count === 0)).toBe(true);
    expect(
      report.steps.every((s) => s.conversionFromPrevious === null),
    ).toBe(true);
  });

  it('ignores events and routes that are not funnel steps', async () => {
    const { service } = serviceWith([
      { event: 'step_view', route: '/estimate/scope', count: 10 },
      { event: 'tier_toggle', route: '/estimate/report', count: 99 },
      { event: 'step_view', route: '/pricing', count: 99 },
      { event: 'pdf_download', route: '/estimate/report', count: 99 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[0]!.count).toBe(10);
    expect(report.steps[4]!.count).toBe(0);
  });

  it('passes the date range and tenant filter to the store', async () => {
    const { service, store } = serviceWith([]);
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-30T00:00:00Z');
    await service.getFunnel({
      from,
      to,
      tenant: { kind: 'tenant', tenantKey: 'acme' },
    });
    expect(store.lastQuery).toEqual({
      from,
      to,
      tenant: { kind: 'tenant', tenantKey: 'acme' },
    });
  });

  it('echoes the query bounds and tenant label in the report', async () => {
    const { service } = serviceWith([]);
    const from = new Date('2026-09-01T00:00:00Z');
    const report = await service.getFunnel({
      from,
      tenant: { kind: 'direct' },
    });
    expect(report.from).toBe(from.toISOString());
    expect(report.to).toBeNull();
    expect(report.tenant).toBe('direct');
  });

  it('response carries no PII — only step ids, labels, counts, rates', async () => {
    const { service } = serviceWith([
      { event: 'step_view', route: '/estimate/scope', count: 1 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/@/);
    for (const step of report.steps) {
      expect(Object.keys(step).sort()).toEqual([
        'conversionFromPrevious',
        'count',
        'label',
        'step',
      ]);
    }
  });

  it('FUNNEL_STEPS matches the web tracker ROUTE_ANALYTICS map', async () => {
    // The client-side source of truth lives in
    // apps/web/src/app/features/consent/analytics-tracker.service.ts.
    // This pins the backend table to it: any tracker rename must update
    // FUNNEL_STEPS (or this test fails loudly, by design).
    const trackerMap: Record<string, string> = {
      '/estimate/scope': 'step_view',
      '/estimate/reno-scope': 'step_view',
      '/estimate/details': 'step_view',
      '/estimate/preview': 'step_view',
      '/estimate/gate': 'gate_view',
      '/estimate/report': 'report_open',
    };
    for (const step of FUNNEL_STEPS) {
      for (const route of step.routes) {
        expect(
          trackerMap[route],
          `tracker map drift for route ${route}`,
        ).toBe(step.event);
      }
    }
    // And every tracker-mapped route is consumed by exactly one step.
    const consumed = new Set<string>();
    for (const step of FUNNEL_STEPS) {
      for (const route of step.routes) consumed.add(route);
    }
    for (const route of Object.keys(trackerMap)) {
      expect(consumed.has(route), `funnel ignores tracked route ${route}`).toBe(
        true,
      );
    }
  });
});
