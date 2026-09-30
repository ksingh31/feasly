/**
 * Builder team state specs (auth/05).
 *
 * Verifies: load populates the user list (and surfaces errors),
 * invite prepends the new user + sets the 'sent' feedback,
 * status/role updates replace the row in place,
 * remove drops the row, and failures surface the action error
 * without mutating the list.
 */
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { of, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BuilderTeamState,
  InviteBuilderTeamUser,
  LoadBuilderTeam,
  RemoveBuilderTeamUser,
  SetBuilderTeamUserRole,
  SetBuilderTeamUserStatus,
} from './builder-team.state';
import { BuilderTeamApiService } from './builder-team-api.service';
import type { BuilderTeamUser } from './builder-auth.contracts';

const ALICE: BuilderTeamUser = {
  id: 'u1',
  name: 'Alice',
  email: 'alice@example.com',
  role: 'builder_admin',
  status: 'active',
  createdAt: '2026-09-28T00:00:00.000Z',
};
const BOB: BuilderTeamUser = {
  id: 'u2',
  name: 'Bob',
  email: 'bob@example.com',
  role: 'builder_member',
  status: 'invited',
  createdAt: '2026-09-28T00:00:00.000Z',
};

function setup(apiOverrides: Partial<Record<string, unknown>> = {}) {
  TestBed.resetTestingModule();
  const api = {
    listUsers: vi.fn().mockReturnValue(of({ users: [ALICE, BOB] })),
    inviteUser: vi.fn().mockReturnValue(
      of({
        user: {
          id: 'u3',
          name: 'Cara',
          email: 'cara@example.com',
          role: 'builder_member',
          status: 'invited',
          createdAt: '2026-09-28T00:00:00.000Z',
        } satisfies BuilderTeamUser,
      }),
    ),
    updateUser: vi.fn().mockImplementation((_id: string, body: object) =>
      of({ ...BOB, ...body }),
    ),
    deleteUser: vi.fn().mockReturnValue(of({ deleted: true })),
    ...apiOverrides,
  };
  TestBed.configureTestingModule({
    providers: [
      provideStore([BuilderTeamState]),
      { provide: BuilderTeamApiService, useValue: api },
    ],
  });
  const store = TestBed.inject(Store);
  return { store, api };
}

describe('BuilderTeamState (auth/05)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('loads the team list into state', async () => {
    const { store } = setup();
    await store.dispatch(new LoadBuilderTeam()).toPromise();
    expect(store.selectSnapshot(BuilderTeamState.users)).toEqual([ALICE, BOB]);
    expect(store.selectSnapshot(BuilderTeamState.status)).toBe('ready');
  });

  it('surfaces a load error without wiping the previous list', async () => {
    const { store } = setup({
      listUsers: vi.fn().mockReturnValue(throwError(() => ({ retryable: true }))),
    });
    await store.dispatch(new LoadBuilderTeam()).toPromise();
    expect(store.selectSnapshot(BuilderTeamState.status)).toBe('error');
    expect(store.selectSnapshot(BuilderTeamState.users)).toEqual([]);
  });

  it('invite prepends the new user and sets the sent feedback', async () => {
    const { store, api } = setup();
    await store.dispatch(new LoadBuilderTeam()).toPromise();
    await store
      .dispatch(new InviteBuilderTeamUser('Cara', 'cara@example.com', 'builder_member'))
      .toPromise();
    expect(api.inviteUser).toHaveBeenCalledWith({
      name: 'Cara',
      email: 'cara@example.com',
      role: 'builder_member',
    });
    const users = store.selectSnapshot(BuilderTeamState.users);
    expect(users[0].email).toBe('cara@example.com');
    expect(users).toHaveLength(3);
    expect(store.selectSnapshot(BuilderTeamState.inviteFeedback)).toBe('sent');
  });

  it('invite failure sets the failed feedback', async () => {
    const { store } = setup({
      inviteUser: vi.fn().mockReturnValue(throwError(() => ({ retryable: true }))),
    });
    await store
      .dispatch(new InviteBuilderTeamUser('Cara', 'cara@example.com', 'builder_member'))
      .toPromise();
    expect(store.selectSnapshot(BuilderTeamState.inviteFeedback)).toBe('failed');
  });

  it('invite sets inviting while in flight and clears it on success', async () => {
    const gate = new Subject<unknown>();
    const { store } = setup({
      inviteUser: vi.fn().mockReturnValue(gate.asObservable()),
    });
    const pending = store
      .dispatch(new InviteBuilderTeamUser('Cara', 'cara@example.com', 'builder_member'))
      .toPromise();
    expect(store.selectSnapshot(BuilderTeamState.inviting)).toBe(true);
    gate.next({ user: { ...BOB, id: 'u3', email: 'cara@example.com' } });
    gate.complete();
    await pending;
    expect(store.selectSnapshot(BuilderTeamState.inviting)).toBe(false);
    expect(store.selectSnapshot(BuilderTeamState.inviteFeedback)).toBe('sent');
  });

  it('invite failure captures the API message and inviting clears', async () => {
    const { store } = setup({
      inviteUser: vi
        .fn()
        .mockReturnValue(
          throwError(() => ({ message: 'An invite is already on its way.' })),
        ),
    });
    await store
      .dispatch(new InviteBuilderTeamUser('Bob', 'bob@example.com', 'builder_member'))
      .toPromise();
    expect(store.selectSnapshot(BuilderTeamState.inviting)).toBe(false);
    expect(store.selectSnapshot(BuilderTeamState.inviteFeedback)).toBe('failed');
    expect(store.selectSnapshot(BuilderTeamState.inviteError)).toBe(
      'An invite is already on its way.',
    );
  });

  it('a new invite clears the previous invite error', async () => {
    const { store, api } = setup({
      inviteUser: vi
        .fn()
        .mockReturnValueOnce(
          throwError(() => ({ message: 'An invite is already on its way.' })),
        )
        .mockReturnValue(of({ user: BOB })),
    });
    await store
      .dispatch(new InviteBuilderTeamUser('Bob', 'bob@example.com', 'builder_member'))
      .toPromise();
    expect(store.selectSnapshot(BuilderTeamState.inviteError)).toBe(
      'An invite is already on its way.',
    );
    // The retry clears the error before the API call resolves.
    const retry = store
      .dispatch(new InviteBuilderTeamUser('Eve', 'eve@example.com', 'builder_member'))
      .toPromise();
    expect(store.selectSnapshot(BuilderTeamState.inviteError)).toBeNull();
    await retry;
    expect(api.inviteUser).toHaveBeenCalledTimes(2);
  });

  it('status update replaces the row in place', async () => {
    const { store } = setup();
    await store.dispatch(new LoadBuilderTeam()).toPromise();
    await store.dispatch(new SetBuilderTeamUserStatus('u2', 'deactivated')).toPromise();
    const users = store.selectSnapshot(BuilderTeamState.users);
    expect(users.find((u) => u.id === 'u2')?.status).toBe('deactivated');
    expect(users).toHaveLength(2);
    expect(store.selectSnapshot(BuilderTeamState.updatingUserId)).toBeNull();
  });

  it('role update replaces the row in place', async () => {
    const { store } = setup();
    await store.dispatch(new LoadBuilderTeam()).toPromise();
    await store.dispatch(new SetBuilderTeamUserRole('u2', 'builder_admin')).toPromise();
    const users = store.selectSnapshot(BuilderTeamState.users);
    expect(users.find((u) => u.id === 'u2')?.role).toBe('builder_admin');
  });

  it('remove drops the row', async () => {
    const { store, api } = setup();
    await store.dispatch(new LoadBuilderTeam()).toPromise();
    await store.dispatch(new RemoveBuilderTeamUser('u2')).toPromise();
    expect(api.deleteUser).toHaveBeenCalledWith('u2');
    const users = store.selectSnapshot(BuilderTeamState.users);
    expect(users.map((u) => u.id)).toEqual(['u1']);
  });

  it('row-action failure surfaces the action error and keeps the list', async () => {
    const { store } = setup({
      updateUser: vi.fn().mockReturnValue(throwError(() => ({ retryable: true }))),
    });
    await store.dispatch(new LoadBuilderTeam()).toPromise();
    await store.dispatch(new SetBuilderTeamUserStatus('u2', 'deactivated')).toPromise();
    expect(store.selectSnapshot(BuilderTeamState.actionError)).toBe(true);
    expect(store.selectSnapshot(BuilderTeamState.users)).toHaveLength(2);
    expect(store.selectSnapshot(BuilderTeamState.updatingUserId)).toBeNull();
  });
});
