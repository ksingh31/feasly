import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../config/config.service';
import { PROPERTY_DATA_SERVICE, providePropertyData } from './property-data.service';

/**
 * Proves the wiring (FE1-002): `providePropertyData()` routes property calls
 * from `propertyData.source` — our own /api/v1 routes by default (#752), the
 * mock harness or the live City API (local dev) on request.
 *
 * REGRESSION (2026-09-24): the implementation choice is resolved per call,
 * not when the factory runs. NGXS v22 instantiates states in an *environment*
 * initializer (before APP_INITIALIZERs), so the factory used to run before
 * ConfigService.load() finished and froze the compiled default (then 'live') — a
 * served `propertyData.source: 'mock'` was silently ignored and the app always
 * hit the City API. The "injected before config load" test pins the fix.
 */
describe('providePropertyData', () => {
  let httpMock: HttpTestingController;

  async function wireWith(source: string, injectBeforeLoad = false) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), providePropertyData()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    // Simulate the NGXS early-injection: grab the service before config loads.
    const early = injectBeforeLoad ? TestBed.inject(PROPERTY_DATA_SERVICE) : null;
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({
      propertyData: { source },
      timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
    });
    await pending;
    return injectBeforeLoad && early ? early : TestBed.inject(PROPERTY_DATA_SERVICE);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it("routes autocomplete to the live City of Calgary client for source 'live'", async () => {
    const service = await wireWith('live');
    const pending = firstValueFrom(service.autocomplete('1420'));
    const req = httpMock.expectOne((r) => r.url.includes('data.calgary.ca'));
    expect(req.request.method).toBe('GET');
    req.flush([]);
    const response = await pending;
    expect(response.suggestions).toEqual([]);
  });

  it("routes autocomplete to the mock harness for source 'mock'", async () => {
    const service = await wireWith('mock');
    const response = await firstValueFrom(service.autocomplete('ave'));
    expect(response.suggestions.length).toBeGreaterThan(0);
    expect(response.suggestions.every((s) => s.address.toLowerCase().includes('ave'))).toBe(true);
    httpMock.expectNone((r) => r.url.includes('data.calgary.ca'));
  });

  it("routes autocomplete to the backend client for source 'backend'", async () => {
    const service = await wireWith('backend');
    const pending = firstValueFrom(service.autocomplete('ave'));
    const req = httpMock.expectOne((r) => r.url.includes('/properties/autocomplete'));
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('q')).toBe('ave');
    req.flush({ suggestions: [] });
    const response = await pending;
    expect(response.suggestions).toEqual([]);
  });

  it('resolves an unknown source to the backend, never the City API (#752)', async () => {
    const service = await wireWith('nope');
    const pending = firstValueFrom(service.autocomplete('1420'));
    httpMock.expectOne((r) => r.url.includes('/api/v1/properties/autocomplete')).flush({ suggestions: [] });
    httpMock.expectNone((r) => r.url.includes('data.calgary.ca'));
    await pending;
  });

  it('routes the property lookup to the backend for source backend (#752)', async () => {
    const service = await wireWith('backend');
    const pending = firstValueFrom(service.getProperty('16 DEERMEADE BA SE'));
    const req = httpMock.expectOne((r) => r.url.includes('/api/v1/properties/lookup'));
    expect(req.request.params.get('addressKey')).toBe('16 DEERMEADE BA SE');
    req.flush({ addressKey: '16 DEERMEADE BA SE', zoning: 'R-C2' });
    httpMock.expectNone((r) => r.url.includes('data.calgary.ca'));
    expect((await pending).zoning).toBe('R-C2');
  });

  it('surfaces an API outage as a retryable error, with no fallback to the City API (#752 AC5)', async () => {
    const service = await wireWith('backend');
    const pending = firstValueFrom(service.autocomplete('1412 Prospect'));
    httpMock
      .expectOne((r) => r.url.includes('/api/v1/properties/autocomplete'))
      .flush({ code: 'DEPENDENCY_UNAVAILABLE', message: 'City data is unavailable.' }, { status: 503, statusText: 'Service Unavailable' });
    await expect(pending).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });
    httpMock.expectNone((r) => r.url.includes('data.calgary.ca'));
  });

  it('honors a served source of mock even when injected before config load', async () => {
    const service = await wireWith('mock', true);
    const response = await firstValueFrom(service.autocomplete('ave'));
    expect(response.suggestions.length).toBeGreaterThan(0);
    httpMock.expectNone((r) => r.url.includes('data.calgary.ca'));
  });
});
