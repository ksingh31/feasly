import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics.service';
import { AnalyticsTrackerService } from './analytics-tracker.service';

@Component({ template: '', standalone: true })
class DummyComponent {}

/**
 * Story consumer/01 call-site handoff: the route-view tracker.
 * - Funnel routes map to their analytics events (DRY — one map, no
 *   per-component calls).
 * - Unmapped routes (landing, analyzing, unknown) emit nothing.
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
          { path: 'estimate/scope', component: DummyComponent },
          { path: 'estimate/reno-scope', component: DummyComponent },
          { path: 'estimate/details', component: DummyComponent },
          { path: 'estimate/preview', component: DummyComponent },
          { path: 'estimate/gate', component: DummyComponent },
          { path: 'estimate/report', component: DummyComponent },
          { path: 'other', component: DummyComponent },
        ]),
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
    for (const path of ['/estimate/scope', '/estimate/reno-scope', '/estimate/details', '/estimate/preview']) {
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

  it('ignores unmapped routes', async () => {
    await router.navigate(['/other']);
    await router.navigate(['/']);
    expect(track).not.toHaveBeenCalled();
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
