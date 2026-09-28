import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { SiteNavComponent } from './site-nav.component';

/**
 * QA audit: skip link first, and a >=44px brand tap target.
 * QA 2026-09-27 reported header navigation as intermittent: the brand link
 * navigates programmatically and is pinned by a regression test.
 * UX audit 2026-09-28: primary nav added (How it works · Community guides ·
 * FAQ) — inline on desktop, hamburger on mobile — same programmatic
 * navigation pattern as the brand.
 */
describe('SiteNavComponent', () => {
  let fixture: ComponentFixture<SiteNavComponent>;

  function setup(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SiteNavComponent],
      providers: [provideHttpClient(), provideRouter([])],
    });
    fixture = TestBed.createComponent(SiteNavComponent);
    fixture.detectChanges();
  }

  it('renders the skip-to-content link as the first tab stop', () => {
    setup();
    const firstLink = fixture.nativeElement.querySelector('nav a');
    expect(firstLink?.classList.contains('skip-link')).toBe(true);
    expect(firstLink?.getAttribute('href')).toBe('#main-content');
    expect(firstLink?.textContent?.trim()).toBe('Skip to content');
  });

  it('gives the brand link a >=44px tap target', () => {
    setup();
    const brand = fixture.nativeElement.querySelector('.nav-brand') as HTMLElement;
    expect(parseFloat(getComputedStyle(brand).minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('renders the approved header: skip link + brand + 3 primary nav links', () => {
    setup();
    const links = [...fixture.nativeElement.querySelectorAll('nav a')];
    expect(links).toHaveLength(5);
    expect(links[1].classList.contains('nav-brand')).toBe(true);
    expect(links[1].getAttribute('aria-label')).toBe('Feasly home');
    const navLabels = links.slice(2).map((l) => l.textContent?.trim());
    expect(navLabels).toEqual(['How it works', 'Community guides', 'FAQ']);
    // No dead auth links: sign-in was deliberately omitted.
    for (const link of links) {
      expect(link.textContent ?? '').not.toMatch(/sign in|log in|sign up/i);
    }
  });

  it('nav links navigate programmatically like the brand (QA: header nav intermittent)', () => {
    setup();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const faqLink = fixture.nativeElement.querySelectorAll('nav a.nav-link')[2] as HTMLAnchorElement;
    // Still a real link for keyboard / open-in-new-tab / crawlers.
    expect(faqLink.getAttribute('href')).toBe('/faq');
    faqLink.click();
    expect(navigateSpy).toHaveBeenCalledWith(['/faq']);
    navigateSpy.mockRestore();
  });

  it('mobile hamburger toggles the menu panel', () => {
    setup();
    const btn = fixture.nativeElement.querySelector('.nav-menu-btn') as HTMLButtonElement;
    expect(fixture.nativeElement.querySelector('.nav-menu')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    fixture.detectChanges();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const menuLinks = [
      ...fixture.nativeElement.querySelectorAll('.nav-menu-link'),
    ].map((l) => (l as HTMLElement).textContent?.trim());
    expect(menuLinks).toEqual(['How it works', 'Community guides', 'FAQ']);
    btn.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.nav-menu')).toBeNull();
  });

  it('brand click always navigates home programmatically (QA: header nav intermittent)', () => {
    setup();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const brand = fixture.nativeElement.querySelector('.nav-brand') as HTMLAnchorElement;
    // Still a real link for keyboard / open-in-new-tab / crawlers.
    expect(brand.getAttribute('href')).toBe('/');
    brand.click();
    expect(navigateSpy).toHaveBeenCalledWith(['/']);
    navigateSpy.mockRestore();
  });
});
