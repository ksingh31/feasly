/**
 * BuilderViewAsApiService tests (2026-09-30, Karan).
 *
 * Asserts the service speaks the frozen `POST/DELETE /api/v1/builder/view-as`
 * route with the right method, URL, body, and credentials. Enforcement
 * (permissions, org scope, admin-target lockdown) is tested on the API.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { BuilderViewAsApiService } from './builder-view-as-api.service';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

describe('BuilderViewAsApiService', () => {
  let service: BuilderViewAsApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
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
    service = TestBed.inject(BuilderViewAsApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('activates view-as with POST { userId }', () => {
    let result: unknown = null;
    service
      .activateViewAs('user-1')
      .subscribe((res) => {
        result = res;
      });
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/view-as'),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ userId: 'user-1' });
    expect(req.request.withCredentials).toBe(true);
    req.flush({
      active: true,
      target: { kind: 'user', id: 'user-1', displayName: 'Team Member' },
    });
    expect(result).toEqual({
      active: true,
      target: { kind: 'user', id: 'user-1', displayName: 'Team Member' },
    });
    httpMock.verify();
  });

  it('exits view-as with DELETE (session-only, no body)', () => {
    let result: unknown = null;
    service.exitViewAs().subscribe((res) => {
      result = res;
    });
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/view-as'),
    );
    expect(req.request.method).toBe('DELETE');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ active: false });
    expect(result).toEqual({ active: false });
    httpMock.verify();
  });
});
