/**
 * BuilderTeamApiService tests (#535, #647).
 *
 * - Resend speaks `POST /api/v1/builder/users/{id}/resend-invite`.
 * - The API's `disabled` status maps to the page's `deactivated` on every
 *   response, and a deactivate PATCH sends `disabled` on the wire.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuilderTeamApiService } from './builder-team-api.service';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const WIRE_USER = {
  id: 'u4',
  name: 'Dan',
  email: 'dan@example.com',
  role: 'builder_member',
  status: 'disabled',
  createdAt: '2026-09-28T00:00:00.000Z',
};

describe('BuilderTeamApiService', () => {
  let service: BuilderTeamApiService;
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
    service = TestBed.inject(BuilderTeamApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('resends an invite with POST to the per-user resend-invite route', () => {
    let result: unknown = null;
    service.resendInvite('u2').subscribe((res) => (result = res));
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/users/u2/resend-invite'),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    const user = { ...WIRE_USER, id: 'u2', status: 'invited' };
    req.flush({ user, emailSent: true });
    expect(result).toEqual({ user, emailSent: true });
  });

  it('maps the wire "disabled" status to "deactivated" on list', () => {
    let users: unknown = null;
    service.listUsers().subscribe((res) => (users = res.users));
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/builder/users'))
      .flush({ users: [WIRE_USER, { ...WIRE_USER, id: 'u5', status: 'active' }] });
    expect(users).toEqual([
      { ...WIRE_USER, status: 'deactivated' },
      { ...WIRE_USER, id: 'u5', status: 'active' },
    ]);
  });

  it('sends "disabled" on the wire to deactivate and maps the response back', () => {
    let updated: unknown = null;
    service
      .updateUser('u4', { status: 'deactivated' })
      .subscribe((res) => (updated = res));
    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/users/u4'),
    );
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ status: 'disabled' });
    req.flush(WIRE_USER);
    expect(updated).toEqual({ ...WIRE_USER, status: 'deactivated' });
  });

  it('passes role changes and reactivation through unchanged', () => {
    service.updateUser('u4', { role: 'builder_admin' }).subscribe();
    service.updateUser('u4', { status: 'active' }).subscribe();
    const reqs = httpMock.match((r) => r.url.endsWith('/api/v1/builder/users/u4'));
    expect(reqs.map((r) => r.request.body)).toEqual([
      { role: 'builder_admin' },
      { status: 'active' },
    ]);
    reqs.forEach((r) => r.flush({ ...WIRE_USER, status: 'active' }));
  });
});
