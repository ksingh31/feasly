/**
 * Funnel service tests (admin/07, #814).
 *
 * Covers: step mapping from (event, route) grouped counts onto the six #814
 * steps (landing → address → preview → gate → convert → report), the legacy
 * preview `step_view` still counting, conversion math (4-decimal rounding),
 * null conversion for the first step and when the previous step is 0,
 * empty data → zero counts (never an error), tenant + utm filter
 * passthrough, the per-(utm_source, utm_campaign) breakdown (grouping,
 * ordering, cap), and the route-bound matchers pinned to the web tracker's
 * ROUTE_ANALYTICS map.
 *
 * The FunnelStore is faked; no database is touched.
 */
import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENT_ALLOWLIST } from '../src/services/analytics.service';
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
  sourceGroupLimit = 25,
): { service: FunnelService; store: { lastQuery: FunnelCountQuery | null } } {
  const store = createFakeStore(rows);
  return { service: createFunnelService({ store, sourceGroupLimit }), store };
}

const ALL = { kind: 'all' } as const;

describe('funnel service', () => {
  it('maps event counts onto the six funnel steps in order', async () => {
    const { service } = serviceWith([
      { event: 'landing_view', route: '/', count: 200 },
      { event: 'address_selected', route: '/', count: 120 },
      { event: 'preview_view', route: '/estimate/preview', count: 60 },
      { event: 'gate_view', route: '/estimate/gate', count: 40 },
      { event: 'gate_convert', route: '/estimate/gate', count: 35 },
      { event: 'report_open', route: '/estimate/report', count: 30 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps.map((s) => s.step)).toEqual([
      'landing',
      'address',
      'preview',
      'gate',
      'convert',
      'report',
    ]);
    expect(report.steps.map((s) => s.count)).toEqual([200, 120, 60, 40, 35, 30]);
  });

  it('counts top-of-funnel events on any route', async () => {
    const { service } = serviceWith([
      { event: 'landing_view', route: '/', count: 7 },
      { event: 'landing_view', route: '/guides/infill', count: 3 },
      { event: 'address_selected', route: '/', count: 4 },
      { event: 'address_selected', route: '/estimate', count: 1 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[0]!.count).toBe(10);
    expect(report.steps[1]!.count).toBe(5);
  });

  it('counts the legacy preview step_view alongside preview_view', async () => {
    const { service } = serviceWith([
      { event: 'step_view', route: '/estimate/preview', count: 20 },
      { event: 'preview_view', route: '/estimate/preview', count: 5 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[2]!.count).toBe(25);
  });

  it('computes step-to-step conversion rates rounded to 4 decimals', async () => {
    const { service } = serviceWith([
      { event: 'landing_view', route: '/', count: 100 },
      { event: 'address_selected', route: '/', count: 33 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[0]!.conversionFromPrevious).toBeNull();
    expect(report.steps[1]!.conversionFromPrevious).toBe(0.33);
  });

  it('returns null conversion when the previous step count is 0', async () => {
    const { service } = serviceWith([
      { event: 'address_selected', route: '/', count: 5 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps[0]!.count).toBe(0);
    expect(report.steps[1]!.count).toBe(5);
    expect(report.steps[1]!.conversionFromPrevious).toBeNull();
  });

  it('returns zero counts for empty data (empty state, never an error)', async () => {
    const { service } = serviceWith([]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps).toHaveLength(6);
    expect(report.steps.every((s) => s.count === 0)).toBe(true);
    expect(report.steps.every((s) => s.conversionFromPrevious === null)).toBe(
      true,
    );
    expect(report.bySource).toEqual([]);
    expect(report.bySourceTruncated).toBe(false);
  });

  it('ignores events and routes that are not funnel steps', async () => {
    const { service } = serviceWith([
      { event: 'landing_view', route: '/', count: 10 },
      // The scope step left the funnel in #814.
      { event: 'step_view', route: '/estimate/scope', count: 99 },
      { event: 'tier_toggle', route: '/estimate/report', count: 99 },
      { event: 'step_view', route: '/pricing', count: 99 },
      { event: 'gate_view', route: '/somewhere-else', count: 99 },
      { event: 'address_search', route: '/', count: 99 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.steps.map((s) => s.count)).toEqual([10, 0, 0, 0, 0, 0]);
  });

  it('passes the date range, tenant and utm filters to the store', async () => {
    const { service, store } = serviceWith([]);
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-30T00:00:00Z');
    await service.getFunnel({
      from,
      to,
      tenant: { kind: 'tenant', tenantKey: 'acme' },
      utmSource: 'google',
      utmCampaign: 'spring-infill',
    });
    expect(store.lastQuery).toEqual({
      from,
      to,
      tenant: { kind: 'tenant', tenantKey: 'acme' },
      utmSource: 'google',
      utmCampaign: 'spring-infill',
    });
  });

  it('omits utm filters from the store query when not set', async () => {
    const { service, store } = serviceWith([]);
    await service.getFunnel({ tenant: ALL });
    expect(store.lastQuery).toEqual({ from: undefined, to: undefined, tenant: ALL });
  });

  it('echoes the query bounds, tenant and utm filters in the report', async () => {
    const { service } = serviceWith([]);
    const from = new Date('2026-09-01T00:00:00Z');
    const report = await service.getFunnel({
      from,
      tenant: { kind: 'direct' },
      utmCampaign: 'spring-infill',
    });
    expect(report.from).toBe(from.toISOString());
    expect(report.to).toBeNull();
    expect(report.tenant).toBe('direct');
    expect(report.utmSource).toBeNull();
    expect(report.utmCampaign).toBe('spring-infill');
  });

  it('groups the funnel by utm_source and utm_campaign (#814)', async () => {
    const { service } = serviceWith([
      { event: 'landing_view', route: '/', utmSource: 'google', utmCampaign: 'spring', count: 100 },
      { event: 'gate_convert', route: '/estimate/gate', utmSource: 'google', utmCampaign: 'spring', count: 10 },
      { event: 'landing_view', route: '/', utmSource: 'google', utmCampaign: 'fall', count: 40 },
      { event: 'landing_view', route: '/', utmSource: null, utmCampaign: null, count: 60 },
      { event: 'report_open', route: '/estimate/report', utmSource: null, utmCampaign: null, count: 5 },
      // Non-funnel events never create a group.
      { event: 'pdf_download', route: '/estimate/report', utmSource: 'bing', utmCampaign: 'x', count: 9 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });

    // Totals span every group.
    expect(report.steps[0]!.count).toBe(200);
    expect(report.steps[4]!.count).toBe(10);

    expect(
      report.bySource.map((g) => [g.utmSource, g.utmCampaign]),
    ).toEqual([
      ['google', 'spring'],
      [null, null],
      ['google', 'fall'],
    ]);
    const spring = report.bySource[0]!;
    expect(spring.steps.map((s) => s.count)).toEqual([100, 0, 0, 0, 10, 0]);
    expect(spring.steps).toHaveLength(FUNNEL_STEPS.length);
    const untagged = report.bySource[1]!;
    expect(untagged.steps[0]!.count).toBe(60);
    expect(untagged.steps[5]!.count).toBe(5);
    expect(report.bySourceTruncated).toBe(false);
  });

  it('treats rows without utm fields as untagged', async () => {
    const { service } = serviceWith([
      { event: 'landing_view', route: '/', count: 3 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.bySource).toEqual([
      { utmSource: null, utmCampaign: null, steps: report.steps },
    ]);
  });

  it('orders ties deterministically and caps the group count', async () => {
    const { service } = serviceWith(
      [
        { event: 'landing_view', route: '/', utmSource: 'meta', utmCampaign: 'a', count: 5 },
        { event: 'landing_view', route: '/', utmSource: 'google', utmCampaign: 'b', count: 5 },
        { event: 'landing_view', route: '/', utmSource: 'google', utmCampaign: 'a', count: 5 },
        { event: 'landing_view', route: '/', utmSource: 'bing', utmCampaign: 'z', count: 1 },
      ],
      2,
    );
    const report = await service.getFunnel({ tenant: ALL });
    expect(report.bySource.map((g) => [g.utmSource, g.utmCampaign])).toEqual([
      ['google', 'a'],
      ['google', 'b'],
    ]);
    expect(report.bySourceTruncated).toBe(true);
    // The cap applies to the breakdown only — totals still count everything.
    expect(report.steps[0]!.count).toBe(16);
  });

  it('response carries no PII — only ids, labels, counts, rates, utm keys', async () => {
    const { service } = serviceWith([
      { event: 'landing_view', route: '/', utmSource: 'google', utmCampaign: 'c', count: 1 },
    ]);
    const report = await service.getFunnel({ tenant: ALL });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/@/);
    const stepKeys = ['conversionFromPrevious', 'count', 'label', 'step'];
    for (const step of report.steps) {
      expect(Object.keys(step).sort()).toEqual(stepKeys);
    }
    for (const group of report.bySource) {
      expect(Object.keys(group).sort()).toEqual(['steps', 'utmCampaign', 'utmSource']);
      for (const step of group.steps) {
        expect(Object.keys(step).sort()).toEqual(stepKeys);
      }
    }
  });

  it('every step event is in the analytics ingest allowlist', async () => {
    for (const step of FUNNEL_STEPS) {
      for (const m of step.matchers) {
        expect(ANALYTICS_EVENT_ALLOWLIST).toContain(m.event);
      }
    }
  });

  it('route-bound matchers agree with the web tracker ROUTE_ANALYTICS map', async () => {
    // The client-side route map lives in
    // apps/web/src/app/features/consent/analytics-tracker.service.ts.
    // Route-bound matchers count route-tracker events, so they must name
    // the event the tracker fires for that route (or this fails loudly).
    // Scope routes are tracked but are no longer a funnel step (#814).
    const trackerMap: Record<string, string> = {
      '/estimate/scope': 'step_view',
      '/estimate/reno-scope': 'step_view',
      '/estimate/preview': 'step_view',
      '/estimate/gate': 'gate_view',
      '/estimate/report': 'report_open',
    };
    for (const step of FUNNEL_STEPS) {
      for (const m of step.matchers) {
        for (const route of m.routes ?? []) {
          expect(trackerMap[route], `tracker map drift for route ${route}`).toBe(
            m.event,
          );
        }
      }
    }
    const consumed = new Set<string>();
    for (const step of FUNNEL_STEPS) {
      for (const m of step.matchers) for (const r of m.routes ?? []) consumed.add(r);
    }
    for (const route of ['/estimate/preview', '/estimate/gate', '/estimate/report']) {
      expect(consumed.has(route), `funnel ignores tracked route ${route}`).toBe(true);
    }
  });
});
