/**
 * BuilderSettingsApiService (#871): speaks the #870 routes with the
 * session cookie.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuilderSettingsApiService } from './builder-settings-api.service';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

describe('BuilderSettingsApiService (#871)', () => {
  let service: BuilderSettingsApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ConfigService,
          useValue: { get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s] },
        },
      ],
    });
    service = TestBed.inject(BuilderSettingsApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs the profile', () => {
    service.getProfile().subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/v1/builder/profile'));
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
  });

  it('PUTs a profile update', () => {
    service.updateProfile({ displayName: 'Elite', logoUrl: null }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/v1/builder/profile'));
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ displayName: 'Elite', logoUrl: null });
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
  });

  it('GETs the embed details', () => {
    service.getEmbed().subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/v1/builder/embed'));
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('POSTs an origin-change request', () => {
    service.requestOriginChange({ add: ['https://a.example'], note: 'staging' }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/v1/builder/embed/origin-requests'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ add: ['https://a.example'], note: 'staging' });
    req.flush({ request: {}, created: true });
  });

  it('maps an API error to its message', () => {
    let message = '';
    service.getProfile().subscribe({ error: (e: { message: string }) => (message = e.message) });
    http
      .expectOne((r) => r.url.endsWith('/api/v1/builder/profile'))
      .flush({ code: 'forbidden', message: 'Nope.' }, { status: 403, statusText: 'Forbidden' });
    expect(message).toBe('Nope.');
  });
});
