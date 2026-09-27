import { HttpHeaders } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { Store } from '@ngxs/store';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { credentialsInterceptor } from './credentials.interceptor';
import { ConfigService } from '../config/config.service';
import { AdminAuthState } from '../../features/admin/admin-auth.state';
import { BuilderState } from '../../features/builder/builder.state';

/**
 * credentialsInterceptor (ADM-10): withCredentials is attached to API-base
 * requests only — never to third-party or same-origin asset URLs. Admin /
 * builder API requests additionally carry `Authorization: Bearer <token>`
 * from the matching NGXS auth state (the cross-origin session cookie never
 * sticks on modern browsers); every other path gets no Authorization
 * header.
 */
describe('credentialsInterceptor', () => {
  const API_BASE = 'https://feasly-dev-api-4fhkep.azurewebsites.net';

  function setup(
    baseUrl: string,
    tokens: { admin?: string | null; builder?: string | null } = {},
  ) {
    const configService = { get: vi.fn().mockReturnValue({ baseUrl }) } as unknown as ConfigService;
    // The selectors are pure functions of the state slice — feed them a
    // minimal fake state.
    const store = {
      selectSnapshot: vi.fn((selector: (s: unknown) => unknown) => {
        if (selector === AdminAuthState.sessionToken) {
          return tokens.admin ?? null;
        }
        if (selector === BuilderState.sessionToken) {
          return tokens.builder ?? null;
        }
        return null;
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ConfigService, useValue: configService },
        { provide: Store, useValue: store },
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

  it('attaches the admin bearer token on /api/v1/admin/* requests', () => {
    const { http, backend } = setup(API_BASE, { admin: 'admin-sess' });
    http.get(`${API_BASE}/api/v1/admin/leads`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/admin/leads`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer admin-sess');
    req.flush({});
    backend.verify();
  });

  it('attaches the builder bearer token on /api/v1/builder/* requests', () => {
    const { http, backend } = setup(API_BASE, { builder: 'builder-sess' });
    http.get(`${API_BASE}/api/v1/builder/auth/me`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/builder/auth/me`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer builder-sess');
    req.flush({});
    backend.verify();
  });

  it('does not cross admin/builder tokens between areas', () => {
    const { http, backend } = setup(API_BASE, {
      admin: 'admin-sess',
      builder: 'builder-sess',
    });
    http.get(`${API_BASE}/api/v1/builder/leads`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/builder/leads`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer builder-sess');
    req.flush({});
    backend.verify();
  });

  it('sends no Authorization header when the area has no token', () => {
    const { http, backend } = setup(API_BASE);
    http.get(`${API_BASE}/api/v1/admin/auth/me`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/admin/auth/me`);
    expect(req.request.headers.get('Authorization')).toBeNull();
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
    backend.verify();
  });

  it('sends no Authorization header on non-auth API paths', () => {
    const { http, backend } = setup(API_BASE, {
      admin: 'admin-sess',
      builder: 'builder-sess',
    });
    http.get(`${API_BASE}/api/v1/properties/autocomplete`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/properties/autocomplete`);
    expect(req.request.headers.get('Authorization')).toBeNull();
    req.flush({});
    backend.verify();
  });

  it('leaves third-party URLs untouched (no credential leak)', () => {
    const { http, backend } = setup(API_BASE, { admin: 'admin-sess' });
    http.get('https://data.calgary.ca/resource/4bsw-nn7w.json').subscribe();
    const req = backend.expectOne('https://data.calgary.ca/resource/4bsw-nn7w.json');
    expect(req.request.withCredentials).toBe(false);
    expect(req.request.headers.get('Authorization')).toBeNull();
    req.flush({});
    backend.verify();
  });

  it('is a no-op when api.baseUrl is empty (mock mode)', () => {
    const { http, backend } = setup('');
    http.get('/api/v1/admin/auth/me').subscribe();
    const req = backend.expectOne('/api/v1/admin/auth/me');
    expect(req.request.withCredentials).toBe(false);
    expect(req.request.headers.get('Authorization')).toBeNull();
    req.flush({});
    backend.verify();
  });

  it('does not match lookalike prefixes of the base URL', () => {
    const { http, backend } = setup(API_BASE, { admin: 'admin-sess' });
    http.get(`${API_BASE}.evil.example/api/v1/admin/auth/me`).subscribe();
    const req = backend.expectOne(`${API_BASE}.evil.example/api/v1/admin/auth/me`);
    expect(req.request.withCredentials).toBe(false);
    expect(req.request.headers.get('Authorization')).toBeNull();
    req.flush({});
    backend.verify();
  });

  it('exposes no request headers of its own on token-free paths', () => {
    const { http, backend } = setup(API_BASE);
    http.get(`${API_BASE}/api/v1/health`).subscribe();
    const req = backend.expectOne(`${API_BASE}/api/v1/health`);
    expect(req.request.headers).toEqual(new HttpHeaders());
    req.flush({});
    backend.verify();
  });
});
