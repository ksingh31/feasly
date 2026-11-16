import { afterNextRender, DestroyRef, inject, Injectable, Injector, PLATFORM_ID } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/** Every page's landmark: `<main id="main-content" tabindex="-1">` (also the skip-link target). */
export const MAIN_CONTENT_ID = 'main-content';

/** Path part of a router URL (no query string or fragment). */
function pathOf(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

/**
 * Focus management on client-side navigation (#832, WCAG 2.4.3 / 4.1.3).
 *
 * In a single-page app the page a screen-reader user was on disappears on
 * navigation, focus falls back to `<body>` and nothing is announced — so
 * after landing → scope → preview → gate → report the reader is stranded
 * at the top of the document with no cue the step changed. After every
 * navigation that changes the path, this moves focus to the new page's
 * `<main>` landmark (VoiceOver/NVDA then read from the new page's start;
 * Tab continues from there).
 *
 * Deliberately conservative:
 * - never on the first navigation (initial load keeps the browser default);
 * - never for query/fragment-only changes (`?open=` drawers, `#section`);
 * - only when focus was lost (still on `<body>`), so a page that focuses
 *   its own control on arrival (e.g. a dialog or input) is left alone;
 * - `preventScroll`, so the router's scroll position is untouched.
 *
 * Started once via `provideAppInitializer` in app.config.ts.
 */
@Injectable({ providedIn: 'root' })
export class RouteFocusService {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private started = false;
  private lastPath: string | null = null;

  /** Begin listening for completed navigations. Idempotent; no-op on the server. */
  start(): void {
    if (this.started || !this.isBrowser) {
      return;
    }
    this.started = true;
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        const path = pathOf(event.urlAfterRedirects);
        const previous = this.lastPath;
        this.lastPath = path;
        if (previous === null || previous === path) {
          return;
        }
        afterNextRender(() => this.focusMain(), { injector: this.injector });
      });
  }

  private focusMain(): void {
    const active = this.document.activeElement;
    if (active && active !== this.document.body && active.isConnected) {
      return;
    }
    const main = this.document.getElementById(MAIN_CONTENT_ID);
    if (main) {
      main.focus({ preventScroll: true });
    }
  }
}
