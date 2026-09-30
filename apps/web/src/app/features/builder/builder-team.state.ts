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
  /** Invite request in flight (busy guard: blocks multi-tap re-entry). */
  inviting: boolean;
  /** Last invite: 'sent' | 'failed' | null. */
  inviteFeedback: 'sent' | 'failed' | null;
  /**
   * The API's own message for the last failed invite, shown inline in the
   * invite dialog (role="alert"). Null when no failure is outstanding.
   */
  inviteError: string | null;
  /** Last row action: 'failed' | null. */
  actionError: boolean;
  /** The API's own message for the last failed row action, if any. */
  actionErrorMessage: string | null;
  /** User id currently being updated/removed (disables its buttons). */
  updatingUserId: string | null;
}

const defaults: BuilderTeamStateModel = {
  users: [],
  status: 'idle',
  inviting: false,
  inviteFeedback: null,
  inviteError: null,
  actionError: false,
  actionErrorMessage: null,
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
  static inviting(state: BuilderTeamStateModel): boolean {
    return state.inviting;
  }

  @Selector()
  static inviteError(state: BuilderTeamStateModel): string | null {
    return state.inviteError;
  }

  @Selector()
  static actionError(state: BuilderTeamStateModel): boolean {
    return state.actionError;
  }

  @Selector()
  static actionErrorMessage(state: BuilderTeamStateModel): string | null {
    return state.actionErrorMessage;
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
    ctx.patchState({
      inviting: true,
      inviteFeedback: null,
      inviteError: null,
      actionError: false,
      actionErrorMessage: null,
    });
    return this.api
      .inviteUser({ name: action.name, email: action.email, role: action.role })
      .pipe(
        tap((response) => {
          const state = ctx.getState();
          ctx.patchState({
            users: [response.user, ...state.users],
            inviteFeedback: 'sent',
            inviting: false,
          });
        }),
        catchError((err: { message?: string }) => {
          ctx.patchState({
            inviting: false,
            inviteFeedback: 'failed',
            // Surface the API's own message (e.g. the 409 duplicate-invite
            // copy) inline in the dialog; never a blank error.
            inviteError:
              err?.message ?? 'Could not send the invite. Please try again.',
          });
          return of(null);
        }),
      );
  }

  @Action(SetBuilderTeamUserStatus)
  setUserStatus(
    ctx: StateContext<BuilderTeamStateModel>,
    action: SetBuilderTeamUserStatus,
  ): Observable<unknown> {
    ctx.patchState({ updatingUserId: action.id, actionError: false, actionErrorMessage: null });
    return this.api.updateUser(action.id, { status: action.status }).pipe(
      tap((updated) => {
        this.replaceUser(ctx, updated);
      }),
      catchError((err: { message?: string }) => {
        ctx.patchState({
          updatingUserId: null,
          actionError: true,
          actionErrorMessage:
            err?.message ?? 'Something went wrong. Please try again.',
        });
        return of(null);
      }),
    );
  }

  @Action(SetBuilderTeamUserRole)
  setUserRole(
    ctx: StateContext<BuilderTeamStateModel>,
    action: SetBuilderTeamUserRole,
  ): Observable<unknown> {
    ctx.patchState({ updatingUserId: action.id, actionError: false, actionErrorMessage: null });
    return this.api.updateUser(action.id, { role: action.role }).pipe(
      tap((updated) => {
        this.replaceUser(ctx, updated);
      }),
      catchError((err: { message?: string }) => {
        ctx.patchState({
          updatingUserId: null,
          actionError: true,
          actionErrorMessage:
            err?.message ?? 'Something went wrong. Please try again.',
        });
        return of(null);
      }),
    );
  }

  @Action(RemoveBuilderTeamUser)
  removeUser(
    ctx: StateContext<BuilderTeamStateModel>,
    action: RemoveBuilderTeamUser,
  ): Observable<unknown> {
    ctx.patchState({ updatingUserId: action.id, actionError: false, actionErrorMessage: null });
    return this.api.deleteUser(action.id).pipe(
      tap(() => {
        const state = ctx.getState();
        ctx.patchState({
          users: state.users.filter((user) => user.id !== action.id),
          updatingUserId: null,
        });
      }),
      catchError((err: { message?: string }) => {
        ctx.patchState({
          updatingUserId: null,
          actionError: true,
          actionErrorMessage:
            err?.message ?? 'Something went wrong. Please try again.',
        });
        return of(null);
      }),
    );
  }

  @Action(ClearBuilderTeamFeedback)
  clearFeedback(ctx: StateContext<BuilderTeamStateModel>): void {
    ctx.patchState({
      inviteFeedback: null,
      inviteError: null,
      actionError: false,
      actionErrorMessage: null,
    });
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
