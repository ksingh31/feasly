import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import {
  CloseDeleteAdminUser,
  CloseEditAdminUser,
  CloseInviteAdminUser,
  DeactivateAdminUser,
  DeleteAdminUser,
  DismissAdminUsersNotice,
  InviteAdminUser,
  LoadAdminUsers,
  OpenDeleteAdminUser,
  OpenEditAdminUser,
  OpenInviteAdminUser,
  ReactivateAdminUser,
  ResendAdminUserInvite,
  UpdateAdminUser,
} from './admin-users.actions';
import { AdminUsersState } from './admin-users.state';

const USER_A: AdminUser = {
  id: '223e4567-e89b-12d3-a456-426614174000',
  email: 'a@example.com',
  name: 'A',
  status: 'active',
  staffRole: 'viewer',
  isProtected: false,
  memberships: [],
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const USER_B: AdminUser = {
  ...USER_A,
  id: '323e4567-e89b-12d3-a456-426614174000',
  email: 'b@example.com',
  name: 'B',
  status: 'invited',
};

const LIST_URL = (r: { url: string; method: string }) =>
  r.url.endsWith('/api/v1/admin/users') && r.method === 'GET';

/**
 * AdminUsersState (auth/03): user table load, invite/update/delete/resend
 * flows, dialog open/close, and durable notices.
 */
describe('AdminUsersState', () => {
  let store: Store;
  let httpMock: HttpTestingController;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        provideStore([AdminUsersState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
  }

  beforeEach(async () => {
    await setup();
  });

  it('loads the user table', async () => {
    const done = store.dispatch(new LoadAdminUsers());
    httpMock.expectOne(LIST_URL).flush({
      users: [USER_A, USER_B],
      total: 2,
      limit: 50,
      offset: 0,
    });
    await done.toPromise();

    expect(store.selectSnapshot(AdminUsersState.users)).toEqual([USER_A, USER_B]);
    expect(store.selectSnapshot(AdminUsersState.total)).toBe(2);
    expect(store.selectSnapshot(AdminUsersState.listStatus)).toBe('idle');
    expect(store.selectSnapshot(AdminUsersState.listError)).toBeNull();
  });

  it('stores the load error on failure', async () => {
    const done = store.dispatch(new LoadAdminUsers());
    httpMock.expectOne(LIST_URL).error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminUsersState.listStatus)).toBe('error');
    expect(store.selectSnapshot(AdminUsersState.listError)).not.toBeNull();
    expect(store.selectSnapshot(AdminUsersState.users)).toEqual([]);
  });

  it('invites a user, closes the dialog, and posts a notice', async () => {
    store.dispatch(new OpenInviteAdminUser());
    expect(store.selectSnapshot(AdminUsersState.inviteOpen)).toBe(true);

    const done = store.dispatch(
      new InviteAdminUser({ email: 'b@example.com', name: 'B', role: 'viewer' }),
    );
    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/admin/users/invite') && r.method === 'POST',
    );
    expect(req.request.body).toMatchObject({ email: 'b@example.com', role: 'viewer' });
    req.flush({ user: USER_B, emailSent: true });
    // The invite refreshes the table.
    httpMock.expectOne(LIST_URL).flush({ users: [USER_B], total: 1, limit: 50, offset: 0 });
    await done.toPromise();

    expect(store.selectSnapshot(AdminUsersState.inviteOpen)).toBe(false);
    expect(store.selectSnapshot(AdminUsersState.inviting)).toBe(false);
    expect(store.selectSnapshot(AdminUsersState.inviteError)).toBeNull();
    expect(store.selectSnapshot(AdminUsersState.notice)).toMatchObject({
      kind: 'success',
    });
  });

  it('stores the invite error when the invite fails', async () => {
    store.dispatch(new OpenInviteAdminUser());
    const done = store.dispatch(
      new InviteAdminUser({ email: 'b@example.com', name: 'B', role: 'viewer' }),
    );
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/users/invite'))
      .error(new ProgressEvent('error'));
    await done.toPromise().catch(() => undefined);

    expect(store.selectSnapshot(AdminUsersState.inviting)).toBe(false);
    expect(store.selectSnapshot(AdminUsersState.inviteError)).not.toBeNull();
    expect(store.selectSnapshot(AdminUsersState.inviteOpen)).toBe(true);
  });

  it('opens and closes the edit dialog', () => {
    store.dispatch(new OpenEditAdminUser(USER_A.id));
    expect(store.selectSnapshot(AdminUsersState.editingId)).toBe(USER_A.id);
    store.dispatch(new CloseEditAdminUser());
    expect(store.selectSnapshot(AdminUsersState.editingId)).toBeNull();
  });

  it('updates a user and replaces the row in the table', async () => {
    const load = store.dispatch(new LoadAdminUsers());
    httpMock.expectOne(LIST_URL).flush({ users: [USER_A], total: 1, limit: 50, offset: 0 });
    await load.toPromise();

    const done = store.dispatch(new UpdateAdminUser(USER_A.id, { name: 'A2' }));
    const req = httpMock.expectOne(
      (r) => r.url.endsWith(`/api/v1/admin/users/${USER_A.id}`) && r.method === 'PATCH',
    );
    expect(req.request.body).toEqual({ name: 'A2' });
    req.flush({ ...USER_A, name: 'A2' });
    await done.toPromise();

    expect(store.selectSnapshot(AdminUsersState.users)).toEqual([
      { ...USER_A, name: 'A2' },
    ]);
    expect(store.selectSnapshot(AdminUsersState.editingId)).toBeNull();
    expect(store.selectSnapshot(AdminUsersState.notice)).toMatchObject({
      kind: 'success',
    });
  });

  it('deactivates and reactivates a user', async () => {
    const load = store.dispatch(new LoadAdminUsers());
    httpMock.expectOne(LIST_URL).flush({ users: [USER_A], total: 1, limit: 50, offset: 0 });
    await load.toPromise();

    let done = store.dispatch(new DeactivateAdminUser(USER_A.id));
    httpMock
      .expectOne((r) => r.url.endsWith(`/api/v1/admin/users/${USER_A.id}`) && r.method === 'PATCH')
      .flush({ ...USER_A, status: 'disabled' });
    await done.toPromise();
    expect(store.selectSnapshot(AdminUsersState.users)[0]?.status).toBe('disabled');

    done = store.dispatch(new ReactivateAdminUser(USER_A.id));
    httpMock
      .expectOne((r) => r.url.endsWith(`/api/v1/admin/users/${USER_A.id}`) && r.method === 'PATCH')
      .flush({ ...USER_A, status: 'active' });
    await done.toPromise();
    expect(store.selectSnapshot(AdminUsersState.users)[0]?.status).toBe('active');
  });

  it('deletes a pending user and removes the row', async () => {
    const load = store.dispatch(new LoadAdminUsers());
    httpMock.expectOne(LIST_URL).flush({
      users: [USER_A, USER_B],
      total: 2,
      limit: 50,
      offset: 0,
    });
    await load.toPromise();

    store.dispatch(new OpenDeleteAdminUser(USER_B.id));
    expect(store.selectSnapshot(AdminUsersState.deletingId)).toBe(USER_B.id);

    const done = store.dispatch(new DeleteAdminUser(USER_B.id));
    httpMock
      .expectOne((r) => r.url.endsWith(`/api/v1/admin/users/${USER_B.id}`) && r.method === 'DELETE')
      .flush({ deleted: true });
    await done.toPromise();

    expect(store.selectSnapshot(AdminUsersState.users)).toEqual([USER_A]);
    expect(store.selectSnapshot(AdminUsersState.deletingId)).toBeNull();
    expect(store.selectSnapshot(AdminUsersState.notice)).toMatchObject({
      kind: 'success',
    });
  });

  it('closes the delete dialog without deleting', () => {
    store.dispatch(new OpenDeleteAdminUser(USER_B.id));
    store.dispatch(new CloseDeleteAdminUser());
    expect(store.selectSnapshot(AdminUsersState.deletingId)).toBeNull();
  });

  it('resends an invite and posts a notice', async () => {
    const load = store.dispatch(new LoadAdminUsers());
    httpMock.expectOne(LIST_URL).flush({ users: [USER_B], total: 1, limit: 50, offset: 0 });
    await load.toPromise();

    const done = store.dispatch(new ResendAdminUserInvite(USER_B.id));
    httpMock
      .expectOne(
        (r) =>
          r.url.endsWith(`/api/v1/admin/users/${USER_B.id}/resend-invite`) &&
          r.method === 'POST',
      )
      .flush({ user: USER_B, emailSent: true });
    await done.toPromise();

    expect(store.selectSnapshot(AdminUsersState.resendingId)).toBeNull();
    expect(store.selectSnapshot(AdminUsersState.notice)).toMatchObject({
      kind: 'success',
    });
  });

  it('dismisses the notice', async () => {
    const done = store.dispatch(new ResendAdminUserInvite(USER_B.id));
    httpMock
      .expectOne((r) => r.url.endsWith('/resend-invite'))
      .flush({ user: USER_B, emailSent: true });
    await done.toPromise();
    expect(store.selectSnapshot(AdminUsersState.notice)).not.toBeNull();

    store.dispatch(new DismissAdminUsersNotice());
    expect(store.selectSnapshot(AdminUsersState.notice)).toBeNull();
  });
});
