import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics.service';
import { AnalyticsTrackerService } from './analytics-tracker.service';
import { CampaignSourceState } from './campaign-source.state';

@Component({ template: '', standalone: true })
class DummyComponent {}

/**
 * Story consumer/01 call-site handoff: the route-view tracker.
 * - Funnel routes map to their analytics events (DRY — one map, no
 *   per-component calls).
 * - Unmapped routes (analyzing, unknown) emit nothing; landing fires
 *   landing_view and preview fires preview_view (#815).
 * - Consent gating stays inside AnalyticsService (mocked here); the tracker
 *   only decides *what* to track, never *whether*.
 */
describe('AnalyticsTrackerService', () => {
  let router: Router;
  let track: ReturnType<typeof vi.fn>;
  let tracker: AnalyticsTrackerService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    track = vi.fn();
    TestBed.configureTestingModule({
      imports: [DummyComponent],
      providers: [
        provideRouter([
          { path: '', component: DummyComponent },
          { path: 'estimate/scope', component: DummyComponent },
          { path: 'estimate/reno-scope', component: DummyComponent },
          { path: 'estimate/preview', component: DummyComponent },
          { path: 'estimate/gate', component: DummyComponent },
          { path: 'estimate/report', component: DummyComponent },
          { path: 'other', component: DummyComponent },
        ]),
        provideStore([CampaignSourceState]),
        { provide: AnalyticsService, useValue: { track } },
      ],
    });
    router = TestBed.inject(Router);
    tracker = TestBed.inject(AnalyticsTrackerService);
    tracker.start();
    // Settle the initial navigation, then ignore whatever it tracked.
    await router.navigate(['/']);
    track.mockClear();
  });

  it('maps wizard steps to step_view', async () => {
    for (const path of ['/estimate/scope', '/estimate/reno-scope']) {
      track.mockClear();
      await router.navigate([path]);
      expect(track).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith('step_view', path);
    }
  });

  it('maps the gate and report routes', async () => {
    await router.navigate(['/estimate/gate']);
    expect(track).toHaveBeenCalledWith('gate_view', '/estimate/gate');

    track.mockClear();
    await router.navigate(['/estimate/report']);
    expect(track).toHaveBeenCalledWith('report_open', '/estimate/report');
  });

  it('maps the preview to preview_view only — never a step_view too (#815)', async () => {
    await router.navigate(['/estimate/preview']);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('preview_view', '/estimate/preview');
  });

  it('maps the landing page to landing_view (#815)', async () => {
    await router.navigate(['/other']);
    track.mockClear();
    await router.navigate(['/'], { queryParams: { utm_source: 'google' } });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('landing_view', '/');
  });

  it('ignores unmapped routes', async () => {
    await router.navigate(['/other']);
    expect(track).not.toHaveBeenCalled();
  });

  it('records the first load campaign source in the store, once (#815)', () => {
    const store = TestBed.inject(Store);
    // The test runner URL carries no utm tags: captured, with no source.
    expect(store.selectSnapshot((s) => s.campaignSource.captured)).toBe(true);
    tracker.start();
    expect(store.selectSnapshot((s) => s.campaignSource.captured)).toBe(true);
  });

  it('strips query params before matching', async () => {
    await router.navigate(['/estimate/scope'], { queryParams: { utm_source: 'test' } });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('step_view', '/estimate/scope');
  });

  it('start() is idempotent — no double tracking', async () => {
    tracker.start();
    tracker.start();
    await router.navigate(['/estimate/scope']);
    expect(track).toHaveBeenCalledTimes(1);
  });
});
