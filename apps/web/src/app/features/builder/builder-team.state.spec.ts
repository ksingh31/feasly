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
import { of, throwError } from 'rxjs';
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
};
const BOB: BuilderTeamUser = {
  id: 'u2',
  name: 'Bob',
  email: 'bob@example.com',
  role: 'builder_member',
  status: 'invited',
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
