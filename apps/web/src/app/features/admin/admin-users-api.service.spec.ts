import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AdminUsersApiService } from './admin-users-api.service';

const USER: AdminUser = {
  id: '223e4567-e89b-12d3-a456-426614174000',
  email: 'teammate@example.com',
  name: 'Teammate',
  status: 'invited',
  staffRole: 'viewer',
  isProtected: false,
  memberships: [],
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

/**
 * AdminUsersApiService (auth/03): endpoint wiring for the admin user
 * management table — list, invite, update, delete, resend.
 */
describe('AdminUsersApiService', () => {
  let service: AdminUsersApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ConfigService],
    });
    service = TestBed.inject(AdminUsersApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('lists users with pagination params', () => {
    service.listUsers(25, 50).subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/users'));
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('limit')).toBe('25');
    expect(req.request.params.get('offset')).toBe('50');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ users: [USER], total: 1, limit: 25, offset: 50 });
  });

  it('invites a user by email', () => {
    service
      .inviteUser({ email: 'new@example.com', name: 'New', role: 'viewer' })
      .subscribe();
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/users/invite'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      email: 'new@example.com',
      name: 'New',
      role: 'viewer',
    });
    expect(req.request.withCredentials).toBe(true);
    req.flush({ user: USER, emailSent: true });
  });

  it('patches a user', () => {
    service.updateUser(USER.id, { name: 'Renamed' }).subscribe();
    const req = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/admin/users/${USER.id}`),
    );
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ name: 'Renamed' });
    expect(req.request.withCredentials).toBe(true);
    req.flush({ ...USER, name: 'Renamed' });
  });

  it('deletes a user and returns the contract shape', () => {
    service.deleteUser(USER.id).subscribe((res) => {
      expect(res).toEqual({ deleted: true });
    });
    const req = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/admin/users/${USER.id}`),
    );
    expect(req.request.method).toBe('DELETE');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ deleted: true });
  });

  it('resends an invite', () => {
    service.resendInvite(USER.id).subscribe();
    const req = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/admin/users/${USER.id}/resend-invite`),
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ user: USER, emailSent: true });
  });
});
