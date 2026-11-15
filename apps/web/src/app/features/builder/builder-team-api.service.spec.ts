/**
 * BuilderTeamApiService tests (#647).
 *
 * The API (`@feasly/contracts` `BuilderOrgUser`) calls a deactivated member
 * `disabled`; the team page calls it `deactivated`. The client maps at the
 * boundary: requests send `disabled`, every response normalizes `disabled`
 * to `deactivated`. Other statuses pass through unchanged.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuilderTeamApiService } from './builder-team-api.service';
import type {
  BuilderTeamInviteResponse,
  BuilderTeamListResponse,
  BuilderTeamUser,
} from './builder-auth.contracts';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const wireUser = (status: string, id = 'u1') => ({
  id,
  name: 'Alice',
  email: 'alice@example.com',
  role: 'builder_member',
  status,
  createdAt: '2026-09-28T00:00:00.000Z',
});

describe('BuilderTeamApiService', () => {
  let service: BuilderTeamApiService;
  let httpMock: HttpTestingController;

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
    service = TestBed.inject(BuilderTeamApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('deactivate sends status "disabled" and maps the response back to "deactivated"', () => {
    let result: BuilderTeamUser | null = null;
    service.updateUser('u1', { status: 'deactivated' }).subscribe((u) => (result = u));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/users/u1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ status: 'disabled' });
    expect(req.request.withCredentials).toBe(true);
    req.flush(wireUser('disabled'));
    expect(result!.status).toBe('deactivated');
  });

  it('reactivate sends status "active" unchanged', () => {
    let result: BuilderTeamUser | null = null;
    service.updateUser('u1', { status: 'active' }).subscribe((u) => (result = u));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/users/u1'));
    expect(req.request.body).toEqual({ status: 'active' });
    req.flush(wireUser('active'));
    expect(result!.status).toBe('active');
  });

  it('role/name updates send no status field', () => {
    service.updateUser('u1', { role: 'builder_admin' }).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/users/u1'));
    expect(req.request.body).toEqual({ role: 'builder_admin' });
    expect('status' in req.request.body).toBe(false);
    req.flush(wireUser('active'));
  });

  it('list normalizes "disabled" to "deactivated" and passes other statuses through', () => {
    let result: BuilderTeamListResponse | null = null;
    service.listUsers().subscribe((r) => (result = r));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/users'));
    expect(req.request.method).toBe('GET');
    req.flush({
      users: [wireUser('active', 'a'), wireUser('invited', 'b'), wireUser('disabled', 'c')],
    });
    expect(result!.users.map((u) => u.status)).toEqual(['active', 'invited', 'deactivated']);
  });

  it('invite response user is normalized too', () => {
    let result: BuilderTeamInviteResponse | null = null;
    service
      .inviteUser({ name: 'Alice', email: 'alice@example.com', role: 'builder_member' })
      .subscribe((r) => (result = r));
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/users/invite'));
    expect(req.request.method).toBe('POST');
    req.flush({ user: wireUser('disabled'), emailSent: true });
    expect(result!.user.status).toBe('deactivated');
    expect(result!.emailSent).toBe(true);
  });
});
