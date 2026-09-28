import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ConfigService } from '../../../core/config/config.service';
import { BrandMarkComponent } from '../brand-mark';

/**
 * Site nav (FE1-001): slim dark bar with the brand mark. The prototype's
 * "Sign in" button is intentionally omitted — magic-link auth is unconfirmed
 * and a button to nowhere would be a dead end. Revisit when auth lands.
 *
 * UX audit 2026-09-28: added minimal primary nav (How it works ·
 * Community guides · FAQ) — inline on desktop, behind a hamburger on
 * mobile — so cautious prospects can check Feasly out before typing an
 * address. Links navigate programmatically (same pattern as the brand):
 * QA 2026-09-27 reported header anchor navigation as intermittent.
 */
@Component({
  selector: 'app-site-nav',
  standalone: true,
  imports: [BrandMarkComponent],
  templateUrl: './site-nav.component.html',
  styleUrl: './site-nav.component.scss',
})
export class SiteNavComponent {
  protected readonly siteName = inject(ConfigService).get('site').name;
  private readonly router = inject(Router);

  /** Header nav links — the cautious-prospect path (UX audit 2026-09-28). */
  protected readonly navLinks = [
    { label: 'How it works', path: '/how-it-works' },
    { label: 'Community guides', path: '/communities' },
    { label: 'FAQ', path: '/faq' },
  ];

  /** Mobile menu open/closed. Desktop renders links inline (CSS). */
  protected readonly menuOpen = signal(false);

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

  /** Nav-link navigation — same programmatic pattern as the brand link. */
  go(event: Event, path: string): void {
    event.preventDefault();
    this.menuOpen.set(false);
    void this.router.navigate([path]);
  }

  /** Mobile hamburger toggle. */
  toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }
}
