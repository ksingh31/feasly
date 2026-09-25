import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import type { AnalyticsEventName } from '@feasly/contracts';
import { AnalyticsService } from './analytics.service';

/**
 * Funnel route-view tracking (story consumer/01 call-site handoff).
 *
 * The single DRY home for every route-implied analytics event: the tracker
 * listens for completed navigations and maps the landed path to its event
 * name. `AnalyticsService.track()` still owns the consent gate, so unmapped
 * routes and pre-consent navigations emit nothing.
 *
 * Notes on the map:
 * - `/` (landing) is deliberately unmapped: it doubles as the marketing
 *   homepage, so a `step_view` there would pollute funnel metrics. The
 *   funnel's measured steps start at `/estimate/scope`.
 * - `/estimate/analyzing` is a transitional loading screen, not a step —
 *   no event.
 * - `tier_toggle` has no call site: the approved report design removed the
 *   finish-tier switcher (display-only tier label), so the contract value
 *   stays unused until a toggle ships.
 *
 * Started once via `provideAppInitializer` in app.config.ts. The service is
 * a root singleton, so the subscription lives for the application lifetime.
 */
const ROUTE_ANALYTICS: Readonly<Record<string, AnalyticsEventName>> = {
  '/estimate/scope': 'step_view',
  '/estimate/reno-scope': 'step_view',
  '/estimate/details': 'step_view',
  '/estimate/preview': 'step_view',
  '/estimate/gate': 'gate_view',
  '/estimate/report': 'report_open',
};

@Injectable({ providedIn: 'root' })
export class AnalyticsTrackerService {
  private readonly router = inject(Router);
  private readonly analytics = inject(AnalyticsService);
  private readonly destroyRef = inject(DestroyRef);
  private started = false;

  /** Begin listening for completed navigations. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        // urlAfterRedirects: track the page actually rendered (guard
        // redirects land here), not the deep link that bounced.
        const path = event.urlAfterRedirects.split('?')[0];
        const name = ROUTE_ANALYTICS[path];
        if (name !== undefined) {
          this.analytics.track(name, path);
        }
      });
  }
}
