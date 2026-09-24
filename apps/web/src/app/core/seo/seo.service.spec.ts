import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service';
import { noindexPatterns } from './seo-routes';
import { SeoService } from './seo.service';

/**
 * SEO-01: per-page SEO tags are set idempotently, route-driven via
 * setForRoute(); canonicals carry the trailing slash; robots is exactly
 * `noindex,nofollow` on the noindex list and absent on indexable routes.
 */
describe('SeoService', () => {
  let service: SeoService;
  let httpMock: HttpTestingController;

  const siteConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: {
      seo: {
        landingTitle: 'Feasly — Landing',
        landing: 'Landing description.',
        scopeTitle: 'Feasly — Scope',
        scope: 'Scope description.',
        detailsTitle: 'Feasly — Details',
        details: 'Details description.',
        reportTitle: 'Feasly — Report',
        report: 'Report description.',
        privacyTitle: 'Feasly — Privacy',
        privacy: 'Privacy description.',
        termsTitle: 'Feasly — Terms',
        terms: 'Terms description.',
        notFoundTitle: 'Feasly — Page not found',
        notFound: 'Not found description.',
      },
    },
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush(siteConfig);
    await pending;
    service = TestBed.inject(SeoService);
  });

  it('sets title, description, OG tags, twitter:card, og:type, and canonical', () => {
    service.setPage({
      title: 'Feasly — Test page',
      description: 'A test page description.',
      path: '/test',
    });
    expect(TestBed.inject(Title).getTitle()).toBe('Feasly — Test page');
    expect(TestBed.inject(Meta).getTag('name="description"')?.content).toBe(
      'A test page description.',
    );
    expect(TestBed.inject(Meta).getTag('property="og:type"')?.content).toBe('website');
    expect(TestBed.inject(Meta).getTag('property="og:url"')?.content).toBe(
      'https://feasly.com/test/',
    );
    expect(TestBed.inject(Meta).getTag('name="twitter:card"')?.content).toBe(
      'summary_large_image',
    );
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    expect(canonical?.href).toBe('https://feasly.com/test/');
  });

  it('updates tags idempotently on repeat calls', () => {
    service.setPage({ title: 'One', description: 'First.', path: '/one' });
    service.setPage({ title: 'Two', description: 'Second.', path: '/two' });
    expect(TestBed.inject(Title).getTitle()).toBe('Two');
    expect(document.querySelectorAll('link[rel="canonical"]').length).toBe(1);
  });

  it('sets absolute og:image and twitter:image from the configured site url', () => {
    service.setPage({ title: 'T', description: 'D', path: '/x' });
    expect(TestBed.inject(Meta).getTag('property="og:image"')?.content).toBe(
      'https://feasly.com/assets/og/og-default.png',
    );
    expect(TestBed.inject(Meta).getTag('name="twitter:image"')?.content).toBe(
      'https://feasly.com/assets/og/og-default.png',
    );
  });

  it('setForRoute resolves title/description from config copy per the route table', () => {
    service.setForRoute('privacy');
    expect(TestBed.inject(Title).getTitle()).toBe('Feasly — Privacy');
    expect(TestBed.inject(Meta).getTag('name="description"')?.content).toBe(
      'Privacy description.',
    );
    expect(TestBed.inject(Meta).getTag('property="og:url"')?.content).toBe(
      'https://feasly.com/privacy/',
    );
  });

  it('setForRoute sets noindex,nofollow exactly on noindex routes', () => {
    service.setForRoute('estimate/scope');
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex,nofollow');
    // canonical still emitted (self-referencing) even when noindexed
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(
      'https://feasly.com/estimate/scope/',
    );
  });

  it('setForRoute removes the robots tag on indexable routes', () => {
    service.setForRoute('estimate/report');
    expect(TestBed.inject(Meta).getTag('name="robots"')).not.toBeNull();
    service.setForRoute('terms');
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });

  it('setForRoute falls back to the 404 entry for unknown routes without throwing', () => {
    expect(() => service.setForRoute('/some/missing/page')).not.toThrow();
    expect(TestBed.inject(Title).getTitle()).toBe('Feasly — Page not found');
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex,nofollow');
  });

  it('works when the Node process global is absent (browser runtime)', () => {
    // Browsers have no `process` binding at all — the ambient TS declaration
    // in seo.service.ts emits nothing at runtime. Optional chaining does not
    // guard undeclared bindings, so a bare `process?.env` reference throws
    // `ReferenceError: process is not defined` in every browser (issue #49:
    // blank wizard pages, stale titles). `delete` reproduces a true browser
    // here; `vi.stubGlobal('process', undefined)` would NOT — an undefined
    // binding is still declared and `?.` would silently pass.
    const g = globalThis as Record<string, unknown>;
    const realProcess = g['process'];
    delete g['process'];
    try {
      expect(() => service.setForRoute('estimate/scope')).not.toThrow();
    } finally {
      g['process'] = realProcess;
    }
    expect(TestBed.inject(Title).getTitle()).toBe('Feasly — Scope');
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex,nofollow');
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(
      'https://feasly.com/estimate/scope/',
    );
  });

  it('covers every story-required noindex pattern', () => {
    const patterns = noindexPatterns();
    for (const required of [
      'estimate/scope',
      'estimate/details',
      'estimate/report',
      'preview',
      'check-email',
      'analyzing',
      'r/:token',
      'embed/**',
      'admin/**',
    ]) {
      expect(patterns).toContain(required);
    }
    // and each of them actually renders the robots tag
    for (const path of ['preview', 'r/abc123', 'embed/acme', 'admin/leads']) {
      service.setForRoute(path);
      expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex,nofollow');
    }
  });

  it('indexable routes carry no robots tag', () => {
    for (const path of ['', 'privacy', 'terms']) {
      service.setForRoute('estimate/scope'); // ensure a tag exists first
      service.setForRoute(path);
      expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
    }
  });

  it('falls back to the request origin when site.url is empty (staging)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    http
      .expectOne('/assets/config/app-config.json')
      .flush({ site: { url: '', socialImage: '/assets/og/og-default.png' }, copy: siteConfig.copy });
    return pending.then(() => {
      const svc = TestBed.inject(SeoService);
      svc.setPage({ title: 'T', description: 'D', path: '/privacy' });
      // The point is the request origin is used — on SWA staging that is the
      // default *.azurestaticapps.net hostname.
      expect(
        document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
      ).toBe(`${document.location.origin}/privacy/`);
    });
  });
});
