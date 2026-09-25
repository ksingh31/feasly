import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../core/config';
import { ErrorRecoveryService } from '../../core/errors/error-recovery.service';
import { ErrorPageComponent } from './error-page.component';

/**
 * HRD-02: the branded /error page renders the story's exact copy, re-fires
 * the failed action on "Try again", is noindexed, and never leaks error
 * text or PII into the DOM.
 */
describe('ErrorPageComponent', () => {
  let fixture: ComponentFixture<ErrorPageComponent>;
  let httpMock: HttpTestingController;
  let recovery: ErrorRecoveryService;

  const baseConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: {
      seo: {
        landingTitle: 'Feasly — Landing',
        landing: 'Landing description.',
        notFoundTitle: 'Feasly — Page not found',
        notFound: 'Not found description.',
        errorTitle: 'Feasly — Something went wrong',
        error: 'Your estimate is safe — try again in a moment.',
      },
    },
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ErrorPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    recovery = TestBed.inject(ErrorRecoveryService);
    fixture = TestBed.createComponent(ErrorPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pageText(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('renders the branded error copy verbatim', () => {
    expect(pageText()).toContain('Something went wrong on our end.');
    expect(pageText()).toContain('Your estimate is safe — try again in a moment.');
    expect(pageText()).toContain('Try again');
    expect(pageText()).toContain('Back to home →');
  });

  it('links "Back to home" to the landing page', () => {
    const link = (fixture.nativeElement as HTMLElement).querySelector('a.link');
    expect(link?.getAttribute('href')).toBe('/');
  });

  it('noindexes the page via setForRoute(error)', () => {
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex,nofollow');
  });

  it('"Try again" re-fires the captured failed action (e.g. a failed estimate POST)', async () => {
    const http = TestBed.inject(HttpClient);
    let succeeded = false;
    recovery.capture({
      description: 'Re-run the estimate',
      retry: () =>
        http.post('/api/v1/estimate', { sqft: 2200 }).subscribe(() => {
          succeeded = true;
        }),
    });

    (fixture.nativeElement as HTMLElement).querySelector('button.cta')?.dispatchEvent(new Event('click'));
    httpMock.expectOne('/api/v1/estimate').flush({ ok: true });
    await fixture.whenStable();

    expect(succeeded).toBe(true);
    // The action is consumed — a second click falls back to reload.
    expect(recovery.failedAction()).toBeNull();
  });

  it('"Try again" with no captured action falls back to reloading the page', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    recovery.clear();

    (fixture.nativeElement as HTMLElement).querySelector('button.cta')?.dispatchEvent(new Event('click'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never renders error text or PII — the DOM carries static copy only', () => {
    recovery.capture({
      description: 'Retry for lead-email@example.com after "s3cret-token" failure',
      retry: () => undefined,
    });
    fixture.detectChanges();

    expect(pageText()).not.toContain('lead-email@example.com');
    expect(pageText()).not.toContain('s3cret-token');
    expect(pageText()).not.toContain('Error:');
  });
});
