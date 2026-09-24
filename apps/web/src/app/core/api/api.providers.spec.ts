import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import type { AnalyticsEvent } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import { API_SERVICE, provideApi } from './api.service';
import { providePropertyData } from './property-data.service';

/**
 * Proves the wiring (FE0-003): `provideApi()` routes calls from
 * `api.useMockApi` — the only switch between mock and live backend.
 *
 * REGRESSION (2026-09-24): the implementation choice is resolved per call,
 * not when the factory runs — the same early-injection hazard as
 * providePropertyData() (NGXS environment initializers run before
 * APP_INITIALIZERs). The "injected before config load" test pins the fix.
 */
describe('provideApi', () => {
  let httpMock: HttpTestingController;

  const event: AnalyticsEvent = { event: 'report_open', route: '/estimate/report', ts: '2026-09-24T00:00:00Z' };

  async function wireWith(useMockApi: boolean, injectBeforeLoad = false) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        provideApi(),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    // Simulate the NGXS early-injection: grab the service before config loads.
    const early = injectBeforeLoad ? TestBed.inject(API_SERVICE) : null;
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi } });
    await pending;
    return injectBeforeLoad && early ? early : TestBed.inject(API_SERVICE);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('routes calls to the mock harness when useMockApi is true', async () => {
    const api = await wireWith(true);
    await firstValueFrom(api.trackEvent(event));
    httpMock.expectNone((r) => r.url.includes('/events'));
  });

  it('routes calls to the HTTP client when useMockApi is false', async () => {
    const api = await wireWith(false);
    const pending = firstValueFrom(api.trackEvent(event));
    const req = httpMock.expectOne((r) => r.url.includes('/events'));
    expect(req.request.method).toBe('POST');
    req.flush(null);
    await pending;
  });

  it('honors a served useMockApi=false even when injected before config load', async () => {
    const api = await wireWith(false, true);
    const pending = firstValueFrom(api.trackEvent(event));
    const req = httpMock.expectOne((r) => r.url.includes('/events'));
    expect(req.request.method).toBe('POST');
    req.flush(null);
    await pending;
  });
});
