import { HttpHeaders } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { credentialsInterceptor } from './credentials.interceptor';
import { ConfigService } from '../config/config.service';

/**
 * credentialsInterceptor (ADM-10): withCredentials is attached to API-base
 * requests only — never to third-party or same-origin asset URLs.
 */
describe('credentialsInterceptor', () => {
  const API_BASE = 'https://feasly-dev-api-4fhkep.azurewebsites.net';

  function setup(baseUrl: string) {
    const configService = { get: vi.fn().mockReturnValue({ baseUrl }) } as unknown as ConfigService;
    TestBed.configureTestingModule({
      providers: [
        { provide: ConfigService, useValue: configService },
        provideHttpClient(withInterceptors([credentialsInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    return {
      http: TestBed.inject(HttpClient),
      backend: TestBed.inject(HttpTestingController),
    };
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('sets withCredentials on requests to the API base URL', () => {
    const { http, backend } = setup(API_BASE);
    http.get(`${API_BASE}/api/v1/admin/auth/me`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/admin/auth/me`);
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
    backend.verify();
  });

  it('leaves third-party URLs untouched (no credential leak)', () => {
    const { http, backend } = setup(API_BASE);
    http.get('https://data.calgary.ca/resource/4bsw-nn7w.json').subscribe();
    const req = backend.expectOne('https://data.calgary.ca/resource/4bsw-nn7w.json');
    expect(req.request.withCredentials).toBe(false);
    req.flush({});
    backend.verify();
  });

  it('is a no-op when api.baseUrl is empty (mock mode)', () => {
    const { http, backend } = setup('');
    http.get('/api/v1/admin/auth/me').subscribe();
    const req = backend.expectOne('/api/v1/admin/auth/me');
    expect(req.request.withCredentials).toBe(false);
    req.flush({});
    backend.verify();
  });

  it('does not match lookalike prefixes of the base URL', () => {
    const { http, backend } = setup(API_BASE);
    http.get(`${API_BASE}.evil.example/api/v1/admin/auth/me`).subscribe();
    const req = backend.expectOne(`${API_BASE}.evil.example/api/v1/admin/auth/me`);
    expect(req.request.withCredentials).toBe(false);
    req.flush({});
    backend.verify();
  });

  it('exposes no request headers of its own', () => {
    const { http, backend } = setup(API_BASE);
    http.get(`${API_BASE}/api/v1/health`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/health`);
    expect(req.request.headers).toEqual(new HttpHeaders());
    req.flush({});
    backend.verify();
  });
});
