import { Component, inject } from '@angular/core';
import { ConnectivityService } from '../../core/errors/connectivity.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';

/**
 * Branded offline page (HRD-02).
 *
 * Rendered by the app shell (not a route) while the API is unreachable —
 * detected by the ConnectivityService health probe, with no service worker
 * per the story's assumption. Copy is verbatim from the story's acceptance
 * criteria; allowlisted from the no-hardcode tripwire and pinned by the
 * component spec. "Try again" re-probes; the shell swaps back to the router
 * outlet the moment the API answers.
 */
@Component({
  selector: 'app-offline-page',
  standalone: true,
  imports: [SiteFooterComponent, SiteNavComponent],
  template: `
    <app-site-nav />
    <main class="state-page" id="main-content" tabindex="-1">
      <p class="code">Offline</p>
      <h1>You're offline.</h1>
      <p class="body">Feasly needs an internet connection to look up City data.</p>
      <button type="button" class="cta" (click)="retry()">Try again</button>
    </main>
    <app-site-footer />
  `,
  styleUrl: './state-page.scss',
})
export class OfflinePageComponent {
  private readonly connectivity = inject(ConnectivityService);

  /** Re-probes the API; the shell restores the app when it answers. */
  retry(): void {
    this.connectivity.checkHealth();
  }
}
