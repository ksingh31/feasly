import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service';
import { HttpApiService } from './http-api.service';
import { providePropertyData } from './property-data.service';

/**
 * Proves the real client maps every ApiService method onto the /api/v1
 * routes with the contract DTOs — so flipping `api.useMockApi` is genuinely
 * the only change needed to point at the live backend (FE0-003).
 */
describe('HttpApiService', () => {
  let service: HttpApiService;
  let httpMock: HttpTestingController;

  const BASE = '/api/v1';

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), providePropertyData()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      api: { baseUrl: '', useMockApi: false, timeoutMs: 15000 },
      // Property routes come from our backend here (FE1-002).
      propertyData: { source: 'backend' },
    });
    await pending;
    // Inject after config loads: the property-data factory selects its
    // implementation from config at injection time.
    service = TestBed.inject(HttpApiService);
  });

  interface RouteCase {
    name: string;
    call: (api: HttpApiService) => Observable<unknown>;
    method: string;
    url: string;
    body?: unknown;
    /** Query params expected on the request (for GET routes). */
    params?: Record<string, string>;
  }

  const estimateRequest = {
    addressKey: 'calgary-1234-14-st-nw',
    sqft: 2400,
    tier: 'premium',
    garage: 'double',
    basement: 'unfinished',
  } as const;

  const cases: RouteCase[] = [
    {
      name: 'autocomplete',
      call: (api) => api.autocomplete('14 st'),
      method: 'GET',
      url: `${BASE}/properties/autocomplete`,
      params: { q: '14 st' },
    },
    {
      name: 'getProperty',
      call: (api) => api.getProperty('calgary-1234-14-st-nw'),
      method: 'GET',
      url: `${BASE}/properties/lookup`,
      params: { addressKey: 'calgary-1234-14-st-nw' },
    },
    {
      name: 'getPreviewEstimate',
      call: (api) => api.getPreviewEstimate(estimateRequest),
      method: 'POST',
      url: `${BASE}/estimates/preview`,
      body: estimateRequest,
    },
    {
      name: 'getEstimate',
      call: (api) => api.getEstimate(estimateRequest),
      method: 'POST',
      url: `${BASE}/estimate`,
      body: estimateRequest,
    },
    {
      name: 'submitLead',
      call: (api) =>
        api.submitLead({
          email: 'buyer@example.com',
          name: 'Test Buyer',
          timeline: '6-12mo',
          marketingConsent: false,
          estimateId: 'est-mock-1',
        }),
      method: 'POST',
      url: `${BASE}/leads`,
    },
    {
      name: 'verifyMagicLink',
      call: (api) => api.verifyMagicLink('tok-123'),
      method: 'GET',
      url: `${BASE}/magic-link/verify?token=tok-123`,
    },
    {
      name: 'reissueMagicLink',
      call: (api) => api.reissueMagicLink({ email: 'buyer@example.com' }),
      method: 'POST',
      url: `${BASE}/magic-link/reissue`,
    },
    {
      name: 'getReport',
      call: (api) => api.getReport('rep-123'),
      method: 'GET',
      url: `${BASE}/reports/rep-123`,
    },
    {
      name: 'getNarrative',
      call: (api) => api.getNarrative('est-1', 'rep-123'),
      method: 'POST',
      url: `${BASE}/estimates/est-1/narrative`,
      body: {},
    },
    {
      name: 'reviseTier',
      call: (api) => api.reviseTier('rep-123', { tier: 'luxury' }),
      method: 'POST',
      url: `${BASE}/reports/rep-123/revisions`,
    },
    {
      name: 'requestCallback',
      call: (api) =>
        api.requestCallback({
          reportToken: 'rep-123',
          name: 'Test Buyer',
          phone: '4035550100',
          window: 'evening',
        }),
      method: 'POST',
      url: `${BASE}/callbacks`,
    },
    {
      name: 'shareWithPartner',
      call: (api) => api.shareWithPartner({ reportToken: 'rep-123', partnerEmail: 'p@example.com' }),
      method: 'POST',
      url: `${BASE}/shares`,
    },
    {
      name: 'trackEvent',
      call: (api) => api.trackEvent({ event: 'step_view', route: '/', ts: '2026-09-24T00:00:00Z', consent_ts: '2026-09-23T23:59:00Z' }),
      method: 'POST',
      url: `${BASE}/events`,
    },
  ];

  for (const c of cases) {
    it(`maps ${c.name} → ${c.method} ${c.url}`, async () => {
      const pending = firstValueFrom(c.call(service));
      const req = c.params
        ? httpMock.expectOne((r) => r.url === c.url && r.method === c.method)
        : httpMock.expectOne(c.url);
      expect(req.request.method).toBe(c.method);
      if (c.body !== undefined) {
        expect(req.request.body).toEqual(c.body);
      }
      if (c.params) {
        for (const [key, value] of Object.entries(c.params)) {
          expect(req.request.params.get(key)).toBe(value);
        }
      }
      req.flush({});
      await pending;
      httpMock.verify();
    });
  }

  it('sends the magic-link token as Bearer auth on getNarrative', async () => {
    const pending = firstValueFrom(service.getNarrative('est-1', 'rep-123'));
    const req = httpMock.expectOne(`${BASE}/estimates/est-1/narrative`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer rep-123');
    req.flush({
      estimateId: 'est-1',
      narrative: 'Summary text.',
      narrativeGeneratedAt: new Date().toISOString(),
      cached: false,
    });
    await pending;
    httpMock.verify();
  });

  it('maps HTTP failures onto the ApiError envelope (retryable on 5xx)', async () => {
    const pending = firstValueFrom(service.getProperty('x'));
    httpMock
      .expectOne((r) => r.url === `${BASE}/properties/lookup`)
      .flush({ code: 'boom', message: 'Down.' }, { status: 500, statusText: 'Error' });
    await expect(pending).rejects.toMatchObject({ code: 'boom', message: 'Down.', retryable: true });
  });

  it('marks 4xx failures as non-retryable with a fallback message', async () => {
    const pending = firstValueFrom(service.getProperty('x'));
    httpMock
      .expectOne((r) => r.url === `${BASE}/properties/lookup`)
      .flush({}, { status: 404, statusText: 'Not Found' });
    await expect(pending).rejects.toMatchObject({ code: 'http_404', retryable: false });
  });
});
