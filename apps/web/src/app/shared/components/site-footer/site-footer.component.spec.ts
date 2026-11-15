import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { SiteFooterComponent } from './site-footer.component';

/** Consumer review 2026-11-13 S7: footer links were 16px tall. */
describe('SiteFooterComponent', () => {
  function render(): HTMLElement {
    TestBed.configureTestingModule({
      imports: [SiteFooterComponent],
      providers: [provideHttpClient(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(SiteFooterComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('gives every footer link a >=44px tap target', () => {
    const links = [...render().querySelectorAll('footer a')] as HTMLElement[];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(parseFloat(getComputedStyle(link).minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  it('keeps the legal and guide links', () => {
    const hrefs = [...render().querySelectorAll('footer a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/privacy', '/terms', '/how-it-works', '/communities', '/faq', '/developers']);
  });
});
