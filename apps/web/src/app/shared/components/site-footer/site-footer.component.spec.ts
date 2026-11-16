import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../../core/config/config.service';
import { SiteFooterComponent } from './site-footer.component';

/** Consumer review 2026-11-13 S7: footer links were 16px tall. */
describe('SiteFooterComponent', () => {
  function render(statusPageUrl?: string): HTMLElement {
    TestBed.configureTestingModule({
      imports: [SiteFooterComponent],
      providers: [provideHttpClient(), provideRouter([])],
    });
    if (statusPageUrl !== undefined) {
      const config = TestBed.inject(ConfigService);
      const real = config.get('site');
      vi.spyOn(config, 'get').mockImplementation(((key: string) =>
        key === 'site' ? { ...real, statusPageUrl } : ConfigService.prototype.get.call(config, key as never)) as never);
    }
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
    expect(hrefs).toEqual([
      '/privacy',
      '/terms',
      '/how-it-works',
      '/communities',
      '/faq',
      '/help',
      '/developers',
      '/my-report',
    ]);
  });

  it('links returning users to /my-report (#704)', () => {
    const link = render().querySelector('footer a[href="/my-report"]');
    expect(link?.textContent?.trim()).toBe('Find my report');
  });

  it('links to the public status page when configured (#831)', () => {
    const link = render('https://status.example.test/').querySelector('footer a[href="https://status.example.test/"]');
    expect(link?.textContent?.trim()).toBe('Status');
    expect(link?.getAttribute('rel')).toBe('noopener');
  });

  it('renders no status link while the status page is unconfigured (no dead links)', () => {
    const footer = render('');
    expect(footer.textContent).not.toContain('Status');
  });
});
