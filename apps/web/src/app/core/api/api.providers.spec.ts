import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service';
import { API_SERVICE, provideApi } from './api.service';
import { HttpApiService } from './http-api.service';
import { MockApiService } from './mock-api.service';
import { providePropertyData } from './property-data.service';

/**
 * Proves the wiring (FE0-003): `provideApi()` selects the implementation
 * from `api.useMockApi` — the only switch between mock and live backend.
 */
describe('provideApi', () => {
  let httpMock: HttpTestingController;

  async function wireWith(useMockApi: boolean) {
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
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi } });
    await pending;
    return TestBed.inject(API_SERVICE);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('provides the mock harness when useMockApi is true', async () => {
    const api = await wireWith(true);
    expect(api).toBeInstanceOf(MockApiService);
  });

  it('provides the HTTP client when useMockApi is false', async () => {
    const api = await wireWith(false);
    expect(api).toBeInstanceOf(HttpApiService);
  });
});
