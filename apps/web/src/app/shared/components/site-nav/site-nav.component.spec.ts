import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { SiteNavComponent } from './site-nav.component';

/**
 * QA audit: skip link first, and a >=44px brand tap target.
 * QA 2026-09-27 reported header navigation as intermittent: the approved
 * nav is brand-only (sign-in was deliberately omitted), so the brand link
 * navigates programmatically and is pinned by a regression test.
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

  it('keeps the approved brand-only header: skip link + brand, nothing else', () => {
    setup();
    const links = [...fixture.nativeElement.querySelectorAll('nav a')];
    expect(links).toHaveLength(2);
    expect(links[1].classList.contains('nav-brand')).toBe(true);
    expect(links[1].getAttribute('aria-label')).toBe('Feasly home');
    // No dead auth/marketing links: sign-in was deliberately omitted.
    for (const link of links) {
      expect(link.textContent ?? '').not.toMatch(/sign in|log in|sign up/i);
    }
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
