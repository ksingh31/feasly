import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { NEVER, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { SeoService } from '../../core/seo/seo.service';
import { AnalyticsService } from '../consent/analytics.service';
import { MyReportPageComponent } from './my-report-page.component';

/**
 * `/my-report` (#704): one email field that reuses
 * POST /api/v1/magic-link/reissue. Known and unknown emails get the SAME
 * neutral confirmation (no address oracle); 429 has its own state; other
 * failures are retryable. The page is noindex.
 */
describe('MyReportPageComponent', () => {
  const copy = DEFAULT_APP_CONFIG.copy.myReport;
  let fixture: ComponentFixture<MyReportPageComponent>;
  let reissue: ReturnType<typeof vi.fn>;
  let track: ReturnType<typeof vi.fn>;
  let setForRoute: ReturnType<typeof vi.spyOn>;

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  async function setup(response: () => Observable<unknown>): Promise<void> {
    TestBed.resetTestingModule();
    reissue = vi.fn().mockImplementation(response);
    track = vi.fn();
    TestBed.configureTestingModule({
      imports: [MyReportPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideStore([]),
        { provide: API_SERVICE, useValue: { reissueMagicLink: reissue } },
        { provide: AnalyticsService, useValue: { track } },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    setForRoute = vi.spyOn(TestBed.inject(SeoService), 'setForRoute');
    fixture = TestBed.createComponent(MyReportPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function submit(email: string): Promise<void> {
    const input = el().querySelector('input[type="email"]') as HTMLInputElement;
    input.value = email;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (el().querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one email field and the CTA, and sets the noindex SEO entry', async () => {
    await setup(() => of({ sent: true }));
    expect(setForRoute).toHaveBeenCalledWith('my-report');
    expect(el().querySelectorAll('input').length).toBe(1);
    expect(el().querySelector('h1')?.textContent).toContain(copy.heading);
    expect(el().querySelector('button[type="submit"]')?.textContent).toContain(copy.cta);
  });

  it('posts the trimmed email and shows the sent state', async () => {
    await setup(() => of({ sent: true }));
    await submit('  qa@example.com ');
    expect(reissue).toHaveBeenCalledWith({ email: 'qa@example.com' });
    expect(el().textContent).toContain(copy.sentHeading);
    expect(el().textContent).toContain(copy.sentBody);
    expect(el().querySelector('form')).toBeNull();
    expect(track).toHaveBeenCalledWith('report_link_request');
  });

  it('shows identical confirmation copy for an unknown email (sent: false)', async () => {
    await setup(() => of({ sent: true }));
    await submit('known@example.com');
    const known = el().querySelector('.card')?.textContent;

    await setup(() => of({ sent: false }));
    await submit('unknown@example.com');
    const unknown = el().querySelector('.card')?.textContent;

    expect(unknown).toBe(known);
  });

  it('shows the loading state while the request is in flight and blocks double submits', async () => {
    await setup(() => NEVER);
    await submit('qa@example.com');
    const button = el().querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain(copy.sendingLabel);
    (el().querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it('shows the rate-limited state on RATE_LIMITED and keeps the form', async () => {
    await setup(() => throwError(() => ({ code: 'RATE_LIMITED', message: 'x', retryable: true })));
    await submit('qa@example.com');
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(copy.rateLimitedBody);
    expect(el().querySelector('form')).toBeTruthy();
  });

  it('shows the error state on other failures and lets the user retry', async () => {
    await setup(() => throwError(() => ({ code: 'NETWORK_ERROR', message: 'x', retryable: true })));
    await submit('qa@example.com');
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(copy.errorBody);
    reissue.mockImplementation(() => of({ sent: true }));
    (el().querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(reissue).toHaveBeenCalledTimes(2);
    expect(el().textContent).toContain(copy.sentHeading);
  });

  it('validates the email without calling the API', async () => {
    await setup(() => of({ sent: true }));
    await submit('not-an-email');
    expect(reissue).not.toHaveBeenCalled();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(copy.emailError);
  });
});
