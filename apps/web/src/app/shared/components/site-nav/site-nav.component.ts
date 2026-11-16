import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
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
interface NavLink {
  readonly label: string;
  readonly path: string;
  readonly queryParams?: Record<string, string | number>;
}

@Component({
  selector: 'app-site-nav',
  standalone: true,
  imports: [BrandMarkComponent],
  templateUrl: './site-nav.component.html',
  styleUrl: './site-nav.component.scss',
  host: { '(document:keydown.escape)': 'onEscape()' },
})
export class SiteNavComponent {
  private readonly config = inject(ConfigService);
  protected readonly siteName = this.config.get('site').name;
  private readonly router = inject(Router);

  /** Header nav links — the cautious-prospect path (UX audit 2026-09-28). */
  protected readonly navLinks = [
    { label: 'How it works', path: '/how-it-works' },
    { label: 'Community guides', path: '/communities' },
    { label: 'FAQ', path: '/faq' },
  ];

  /**
   * Mobile menu links (consumer review 2026-11-13 S6): the desktop links
   * plus Compare and Developers, which the 3-link menu was missing.
   */
  protected readonly menuLinks: ReadonlyArray<NavLink> = [
    { label: 'How it works', path: '/how-it-works' },
    { label: 'Community guides', path: '/communities' },
    { label: 'Compare neighbourhoods', path: '/estimate/compare', queryParams: { fresh: 1 } },
    { label: 'FAQ', path: '/faq' },
    { label: 'Developers', path: '/developers' },
    // #704: returning users on another device request their report link.
    // Optional chaining: page specs stub ConfigService with partial copy.
    { label: this.config.get('copy')?.returning?.findReportLink ?? '', path: '/my-report' },
  ];

  /** Primary action in the mobile menu (S6) — the address search on `/`. */
  protected readonly menuCta: NavLink = { label: 'Get an estimate', path: '/' };

  private readonly menuBtn = viewChild<ElementRef<HTMLButtonElement>>('menuBtn');

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
    // QA 2026-10-04 (P1): on the current page the nav doesn't remount, so
    // an open mobile menu would keep covering the page after a brand tap.
    this.menuOpen.set(false);
    void this.router.navigate(['/']);
  }

  /** Nav-link navigation — same programmatic pattern as the brand link. */
  go(event: Event, path: string, queryParams?: Record<string, string | number>): void {
    event.preventDefault();
    this.menuOpen.set(false);
    void (queryParams
      ? this.router.navigate([path], { queryParams })
      : this.router.navigate([path]));
  }

  /** Real href for a link (keyboard, open-in-new-tab, crawlers). */
  protected href(link: NavLink): string {
    return this.router.serializeUrl(
      this.router.createUrlTree([link.path], { queryParams: link.queryParams }),
    );
  }

  /** Scrim / outside tap closes the menu (S6). */
  closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** Escape closes the open menu and returns focus to the hamburger (S6). */
  onEscape(): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    this.menuBtn()?.nativeElement.focus();
  }

  /** Mobile hamburger toggle. */
  toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }
}
