import { DestroyRef, inject, Injectable, PLATFORM_ID } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { filter } from 'rxjs';
import type { AnalyticsEventName } from '@feasly/contracts';
import { AnalyticsService } from './analytics.service';
import { parseCampaignSource } from './campaign-source';
import { CaptureCampaignSource } from './campaign-source.state';

/**
 * Funnel route-view tracking (story consumer/01 call-site handoff).
 *
 * The single DRY home for every route-implied analytics event: the tracker
 * listens for completed navigations and maps the landed path to its event
 * name. `AnalyticsService.track()` still owns the consent gate, so unmapped
 * routes and pre-consent navigations emit nothing.
 *
 * Notes on the map:
 * - `/` (landing) fires `landing_view` (#815), its own event, never a
 *   `step_view` — the homepage view must not pollute the step metrics.
 * - `/estimate/preview` fires `preview_view` (#814/#815) instead of the
 *   legacy `step_view` — the funnel counts either, so never both.
 * - `/estimate/analyzing` is a transitional loading screen, not a step —
 *   no event.
 * - `tier_toggle` has no call site: the approved report design removed the
 *   finish-tier switcher (display-only tier label), so the contract value
 *   stays unused until a toggle ships.
 *
 * #815: `start()` also records the session's campaign attribution (utm
 * tags, click-id type, first external referrer host) from the first load's
 * URL, before the router can rewrite it. Browser only; first touch wins.
 *
 * Started once via `provideAppInitializer` in app.config.ts. The service is
 * a root singleton, so the subscription lives for the application lifetime.
 */
const ROUTE_ANALYTICS: Readonly<Record<string, AnalyticsEventName>> = {
  '/estimate/scope': 'step_view',
  '/estimate/reno-scope': 'step_view',
  '/': 'landing_view',
  '/estimate/preview': 'preview_view',
  '/estimate/gate': 'gate_view',
  '/estimate/report': 'report_open',
};

@Injectable({ providedIn: 'root' })
export class AnalyticsTrackerService {
  private readonly router = inject(Router);
  private readonly analytics = inject(AnalyticsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly store = inject(Store);
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private started = false;

  /** Begin listening for completed navigations. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.captureCampaignSource();
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

  /** #815: read the landing URL + referrer once (browser only, no network). */
  private captureCampaignSource(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const location = this.document.location;
    this.store.dispatch(
      new CaptureCampaignSource(
        parseCampaignSource(location?.search ?? '', this.document.referrer ?? '', location?.hostname ?? ''),
      ),
    );
  }
}
