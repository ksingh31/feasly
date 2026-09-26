import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../config/config.service';
import { PROPERTY_DATA_SERVICE, providePropertyData } from './property-data.service';

/**
 * Proves the wiring (FE1-002): `providePropertyData()` routes property calls
 * from `propertyData.source` — live City API by default, the mock harness or
 * our own /api/v1 routes on request.
 *
 * REGRESSION (2026-09-24): the implementation choice is resolved per call,
 * not when the factory runs. NGXS v22 instantiates states in an *environment*
 * initializer (before APP_INITIALIZERs), so the factory used to run before
 * ConfigService.load() finished and froze the compiled default ('live') — a
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

  it('defaults to the live client when source is unknown', async () => {
    const service = await wireWith('nope');
    const pending = firstValueFrom(service.autocomplete('1420'));
    httpMock.expectOne((r) => r.url.includes('data.calgary.ca')).flush([]);
    await pending;
  });

  it('honors a served source of mock even when injected before config load', async () => {
    const service = await wireWith('mock', true);
    const response = await firstValueFrom(service.autocomplete('ave'));
    expect(response.suggestions.length).toBeGreaterThan(0);
    httpMock.expectNone((r) => r.url.includes('data.calgary.ca'));
  });
});
