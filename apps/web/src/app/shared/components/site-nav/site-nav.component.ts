import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ConfigService } from '../../../core/config/config.service';

/**
 * Site nav (FE1-001): slim dark bar with the brand mark. The prototype's
 * "Sign in" button is intentionally omitted — magic-link auth is unconfirmed
 * and a button to nowhere would be a dead end. Revisit when auth lands.
 */
@Component({
  selector: 'app-site-nav',
  standalone: true,
  templateUrl: './site-nav.component.html',
  styleUrl: './site-nav.component.scss',
})
export class SiteNavComponent {
  protected readonly siteName = inject(ConfigService).get('site').name;
  private readonly router = inject(Router);

  /**
   * Brand home navigation. QA 2026-09-27 reported header navigation as
   * intermittent, so the brand navigates programmatically — the same
   * `router.navigate` path the landing page's own property-select uses —
   * instead of relying on anchor-click interception. The href keeps it a
   * real link (keyboard, open-in-new-tab, crawlers).
   */
  goHome(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/']);
  }
}
