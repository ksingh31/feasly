import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type { BuilderTeamUser } from './builder-auth.contracts';
import { BuilderTeamApiService } from './builder-team-api.service';

/** Invite a teammate (builder_admin only). */
export class InviteBuilderTeamUser {
  static readonly type = '[BuilderTeam] Invite user';
  constructor(
    public readonly name: string,
    public readonly email: string,
    public readonly role: 'builder_admin' | 'builder_member',
  ) {}
}

/** Load the org's team list. */
export class LoadBuilderTeam {
  static readonly type = '[BuilderTeam] Load team';
}

/** Deactivate / reactivate a team user (builder_admin only). */
export class SetBuilderTeamUserStatus {
  static readonly type = '[BuilderTeam] Set user status';
  constructor(
    public readonly id: string,
    public readonly status: 'active' | 'deactivated',
  ) {}
}

/** Change a team user's role (builder_admin only). */
export class SetBuilderTeamUserRole {
  static readonly type = '[BuilderTeam] Set user role';
  constructor(
    public readonly id: string,
    public readonly role: 'builder_admin' | 'builder_member',
  ) {}
}

/** Remove a team user (builder_admin only). */
export class RemoveBuilderTeamUser {
  static readonly type = '[BuilderTeam] Remove user';
  constructor(public readonly id: string) {}
}

/** Clear the last invite/action feedback. */
export class ClearBuilderTeamFeedback {
  static readonly type = '[BuilderTeam] Clear feedback';
}

export type BuilderTeamStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BuilderTeamStateModel {
  users: readonly BuilderTeamUser[];
  status: BuilderTeamStatus;
  /** Last invite: 'sent' | 'failed' | null. */
  inviteFeedback: 'sent' | 'failed' | null;
  /** Last row action: 'failed' | null. */
  actionError: boolean;
  /** User id currently being updated/removed (disables its buttons). */
  updatingUserId: string | null;
}

const defaults: BuilderTeamStateModel = {
  users: [],
  status: 'idle',
  inviteFeedback: null,
  actionError: false,
  updatingUserId: null,
};

/**
 * Builder team state (auth/05): the org user list + invite/manage actions.
 * Separate slice from BuilderState (auth session) — the team page is the
 * only consumer.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription.
 */
@State<BuilderTeamStateModel>({
  name: 'builderTeam',
  defaults,
})
@Injectable()
export class BuilderTeamState {
  private readonly api = inject(BuilderTeamApiService);

  @Selector()
  static users(state: BuilderTeamStateModel): readonly BuilderTeamUser[] {
    return state.users;
  }

  @Selector()
  static status(state: BuilderTeamStateModel): BuilderTeamStatus {
    return state.status;
  }

  @Selector()
  static inviteFeedback(state: BuilderTeamStateModel): 'sent' | 'failed' | null {
    return state.inviteFeedback;
  }

  @Selector()
  static actionError(state: BuilderTeamStateModel): boolean {
    return state.actionError;
  }

  @Selector()
  static updatingUserId(state: BuilderTeamStateModel): string | null {
    return state.updatingUserId;
  }

  @Action(LoadBuilderTeam)
  loadTeam(ctx: StateContext<BuilderTeamStateModel>): Observable<unknown> {
    ctx.patchState({ status: 'loading' });
    return this.api.listUsers().pipe(
      tap((response) => {
        ctx.patchState({ users: response.users, status: 'ready' });
      }),
      catchError(() => {
        ctx.patchState({ status: 'error' });
        return of(null);
      }),
    );
  }

  @Action(InviteBuilderTeamUser)
  inviteUser(
    ctx: StateContext<BuilderTeamStateModel>,
    action: InviteBuilderTeamUser,
  ): Observable<unknown> {
    ctx.patchState({ inviteFeedback: null, actionError: false });
    return this.api
      .inviteUser({ name: action.name, email: action.email, role: action.role })
      .pipe(
        tap((response) => {
          const state = ctx.getState();
          ctx.patchState({
            users: [response.user, ...state.users],
            inviteFeedback: 'sent',
          });
        }),
        catchError(() => {
          ctx.patchState({ inviteFeedback: 'failed' });
          return of(null);
        }),
      );
  }

  @Action(SetBuilderTeamUserStatus)
  setUserStatus(
    ctx: StateContext<BuilderTeamStateModel>,
    action: SetBuilderTeamUserStatus,
  ): Observable<unknown> {
    ctx.patchState({ updatingUserId: action.id, actionError: false });
    return this.api.updateUser(action.id, { status: action.status }).pipe(
      tap((updated) => {
        this.replaceUser(ctx, updated);
      }),
      catchError(() => {
        ctx.patchState({ updatingUserId: null, actionError: true });
        return of(null);
      }),
    );
  }

  @Action(SetBuilderTeamUserRole)
  setUserRole(
    ctx: StateContext<BuilderTeamStateModel>,
    action: SetBuilderTeamUserRole,
  ): Observable<unknown> {
    ctx.patchState({ updatingUserId: action.id, actionError: false });
    return this.api.updateUser(action.id, { role: action.role }).pipe(
      tap((updated) => {
        this.replaceUser(ctx, updated);
      }),
      catchError(() => {
        ctx.patchState({ updatingUserId: null, actionError: true });
        return of(null);
      }),
    );
  }

  @Action(RemoveBuilderTeamUser)
  removeUser(
    ctx: StateContext<BuilderTeamStateModel>,
    action: RemoveBuilderTeamUser,
  ): Observable<unknown> {
    ctx.patchState({ updatingUserId: action.id, actionError: false });
    return this.api.deleteUser(action.id).pipe(
      tap(() => {
        const state = ctx.getState();
        ctx.patchState({
          users: state.users.filter((user) => user.id !== action.id),
          updatingUserId: null,
        });
      }),
      catchError(() => {
        ctx.patchState({ updatingUserId: null, actionError: true });
        return of(null);
      }),
    );
  }

  @Action(ClearBuilderTeamFeedback)
  clearFeedback(ctx: StateContext<BuilderTeamStateModel>): void {
    ctx.patchState({ inviteFeedback: null, actionError: false });
  }

  private replaceUser(
    ctx: StateContext<BuilderTeamStateModel>,
    updated: BuilderTeamUser,
  ): void {
    const state = ctx.getState();
    ctx.patchState({
      users: state.users.map((user) =>
        user.id === updated.id ? updated : user,
      ),
      updatingUserId: null,
    });
  }
}
