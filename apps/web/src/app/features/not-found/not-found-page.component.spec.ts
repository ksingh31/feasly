import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config';
import { NotFoundPageComponent } from './not-found-page.component';

/**
 * SEO-01: the branded 404 renders the story's exact copy, links home, and is
 * noindexed (it also backs the wildcard route).
 */
describe('NotFoundPageComponent', () => {
  let fixture: ComponentFixture<NotFoundPageComponent>;
  let httpMock: HttpTestingController;

  const baseConfig = {
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
      imports: [NotFoundPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    fixture = TestBed.createComponent(NotFoundPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the branded 404 copy verbatim', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain("That page doesn't exist.");
    expect(text).toContain("The page you're looking for moved or never existed.");
    expect(text).toContain('Back to home →');
  });

  it('links the CTA to the home page', () => {
    const cta = (fixture.nativeElement as HTMLElement).querySelector('a.cta');
    expect(cta?.getAttribute('href')).toBe('/');
  });

  it('noindexes the page via setForRoute(404)', () => {
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex,nofollow');
  });
});
