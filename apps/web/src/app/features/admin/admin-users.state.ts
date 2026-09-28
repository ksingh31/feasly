import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type {
  AdminUser,
  AdminUserDeleteResponse,
  AdminUserInviteResponse,
  AdminUserListResponse,
  AdminUserResendInviteResponse,
} from '@feasly/contracts';
import { AdminUsersApiService } from './admin-users-api.service';
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

/** List loading lifecycle. */
export type AdminUsersListStatus = 'idle' | 'loading' | 'error';

/** A transient notice shown after a mutation (toast-style banner). */
export interface AdminUsersNotice {
  readonly kind: 'success' | 'error';
  readonly message: string;
}

export interface AdminUsersStateModel {
  /** Team users, newest first (server-sorted). */
  users: AdminUser[];
  total: number;
  listStatus: AdminUsersListStatus;
  listError: string | null;
  /** Invite modal open state. */
  inviteOpen: boolean;
  inviting: boolean;
  inviteError: string | null;
  /** Edit drawer state. */
  editingId: string | null;
  updating: boolean;
  updateError: string | null;
  /** Delete confirmation state. */
  deletingId: string | null;
  deleting: boolean;
  deleteError: string | null;
  /** Resend-invite in flight for a user id. */
  resendingId: string | null;
  /** Transient success/error banner. */
  notice: AdminUsersNotice | null;
}

const defaults: AdminUsersStateModel = {
  users: [],
  total: 0,
  listStatus: 'idle',
  listError: null,
  inviteOpen: false,
  inviting: false,
  inviteError: null,
  editingId: null,
  updating: false,
  updateError: null,
  deletingId: null,
  deleting: false,
  deleteError: null,
  resendingId: null,
  notice: null,
};

/**
 * Admin user-management state (auth/03).
 *
 * Memory-only — deliberately NOT registered with the storage plugin: user
 * rows are sensitive and refetch cheaply on mount (same stance as the
 * disputes and calibration states).
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription, so a newer `LoadAdminUsers` cancels an
 * in-flight load and no stale response can overwrite a newer result.
 */
@State<AdminUsersStateModel>({
  name: 'adminUsers',
  defaults,
})
@Injectable()
export class AdminUsersState {
  private readonly api = inject(AdminUsersApiService);

  // ------------------------------------------------------------------ selectors

  @Selector()
  static users(state: AdminUsersStateModel): AdminUser[] {
    return state.users;
  }

  @Selector()
  static total(state: AdminUsersStateModel): number {
    return state.total;
  }

  @Selector()
  static listStatus(state: AdminUsersStateModel): AdminUsersListStatus {
    return state.listStatus;
  }

  @Selector()
  static listError(state: AdminUsersStateModel): string | null {
    return state.listError;
  }

  @Selector()
  static inviteOpen(state: AdminUsersStateModel): boolean {
    return state.inviteOpen;
  }

  @Selector()
  static inviting(state: AdminUsersStateModel): boolean {
    return state.inviting;
  }

  @Selector()
  static inviteError(state: AdminUsersStateModel): string | null {
    return state.inviteError;
  }

  @Selector()
  static editingId(state: AdminUsersStateModel): string | null {
    return state.editingId;
  }

  @Selector()
  static updating(state: AdminUsersStateModel): boolean {
    return state.updating;
  }

  @Selector()
  static updateError(state: AdminUsersStateModel): string | null {
    return state.updateError;
  }

  @Selector()
  static deletingId(state: AdminUsersStateModel): string | null {
    return state.deletingId;
  }

  @Selector()
  static deleting(state: AdminUsersStateModel): boolean {
    return state.deleting;
  }

  @Selector()
  static deleteError(state: AdminUsersStateModel): string | null {
    return state.deleteError;
  }

  @Selector()
  static resendingId(state: AdminUsersStateModel): string | null {
    return state.resendingId;
  }

  @Selector()
  static notice(state: AdminUsersStateModel): AdminUsersNotice | null {
    return state.notice;
  }

  // ------------------------------------------------------------------ actions

  @Action(LoadAdminUsers)
  load(
    ctx: StateContext<AdminUsersStateModel>,
  ): Observable<AdminUserListResponse> {
    ctx.patchState({ listStatus: 'loading', listError: null });
    return this.api.listUsers().pipe(
      tap({
        next: (res) => {
          ctx.patchState({
            users: [...res.users],
            total: res.total,
            listStatus: 'idle',
            listError: null,
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            listStatus: 'error',
            listError: err?.message ?? 'Could not load users. Please try again.',
          });
        },
      }),
    );
  }

  @Action(OpenInviteAdminUser)
  openInvite(ctx: StateContext<AdminUsersStateModel>): void {
    ctx.patchState({ inviteOpen: true, inviteError: null, notice: null });
  }

  @Action(CloseInviteAdminUser)
  closeInvite(ctx: StateContext<AdminUsersStateModel>): void {
    ctx.patchState({ inviteOpen: false, inviteError: null });
  }

  @Action(InviteAdminUser)
  invite(
    ctx: StateContext<AdminUsersStateModel>,
    action: InviteAdminUser,
  ): Observable<AdminUserInviteResponse> {
    ctx.patchState({ inviting: true, inviteError: null });
    return this.api.inviteUser(action.body).pipe(
      tap({
        next: (res) => {
          ctx.patchState({
            inviting: false,
            inviteOpen: false,
            inviteError: null,
            notice: {
              kind: 'success',
              message: res.emailSent
                ? `Invite sent to ${res.user.email}.`
                : `User ${res.user.email} added (the invite email could not be sent — ask them to sign in).`,
            },
          });
          ctx.dispatch(new LoadAdminUsers());
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            inviting: false,
            inviteError: err?.message ?? 'Could not send the invite. Please try again.',
          });
        },
      }),
    );
  }

  @Action(OpenEditAdminUser)
  openEdit(
    ctx: StateContext<AdminUsersStateModel>,
    action: OpenEditAdminUser,
  ): void {
    ctx.patchState({ editingId: action.id, updateError: null, notice: null });
  }

  @Action(CloseEditAdminUser)
  closeEdit(ctx: StateContext<AdminUsersStateModel>): void {
    ctx.patchState({ editingId: null, updateError: null });
  }

  @Action(UpdateAdminUser)
  update(
    ctx: StateContext<AdminUsersStateModel>,
    action: UpdateAdminUser,
  ): Observable<AdminUser> {
    ctx.patchState({ updating: true, updateError: null });
    return this.api.updateUser(action.id, action.body).pipe(
      tap({
        next: (user) => {
          ctx.patchState({
            updating: false,
            editingId: null,
            updateError: null,
            users: ctx.getState().users.map((u) => (u.id === user.id ? user : u)),
            notice: { kind: 'success', message: `${user.email} updated.` },
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            updating: false,
            updateError: err?.message ?? 'Could not update the user. Please try again.',
          });
        },
      }),
    );
  }

  @Action(DeactivateAdminUser)
  deactivate(
    ctx: StateContext<AdminUsersStateModel>,
    action: DeactivateAdminUser,
  ): Observable<AdminUser> {
    return this.toggleActive(ctx, action.id, false);
  }

  @Action(ReactivateAdminUser)
  reactivate(
    ctx: StateContext<AdminUsersStateModel>,
    action: ReactivateAdminUser,
  ): Observable<AdminUser> {
    return this.toggleActive(ctx, action.id, true);
  }

  @Action(OpenDeleteAdminUser)
  openDelete(
    ctx: StateContext<AdminUsersStateModel>,
    action: OpenDeleteAdminUser,
  ): void {
    ctx.patchState({ deletingId: action.id, deleteError: null, notice: null });
  }

  @Action(CloseDeleteAdminUser)
  closeDelete(ctx: StateContext<AdminUsersStateModel>): void {
    ctx.patchState({ deletingId: null, deleteError: null });
  }

  @Action(DeleteAdminUser)
  delete(
    ctx: StateContext<AdminUsersStateModel>,
    action: DeleteAdminUser,
  ): Observable<AdminUserDeleteResponse> {
    ctx.patchState({ deleting: true, deleteError: null });
    return this.api.deleteUser(action.id).pipe(
      tap({
        next: () => {
          const removed = ctx
            .getState()
            .users.find((u) => u.id === action.id);
          ctx.patchState({
            deleting: false,
            deletingId: null,
            deleteError: null,
            users: ctx.getState().users.filter((u) => u.id !== action.id),
            total: Math.max(0, ctx.getState().total - 1),
            notice: {
              kind: 'success',
              message: removed
                ? `${removed.email} deleted.`
                : 'User deleted.',
            },
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            deleting: false,
            deleteError: err?.message ?? 'Could not delete the user. Please try again.',
          });
        },
      }),
    );
  }

  @Action(ResendAdminUserInvite)
  resend(
    ctx: StateContext<AdminUsersStateModel>,
    action: ResendAdminUserInvite,
  ): Observable<AdminUserResendInviteResponse> {
    ctx.patchState({ resendingId: action.id });
    return this.api.resendInvite(action.id).pipe(
      tap({
        next: (res) => {
          ctx.patchState({
            resendingId: null,
            notice: {
              kind: 'success',
              message: res.emailSent
                ? `Invite resent to ${res.user.email}.`
                : 'Invite reissued, but the email could not be sent.',
            },
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            resendingId: null,
            notice: {
              kind: 'error',
              message: err?.message ?? 'Could not resend the invite. Please try again.',
            },
          });
        },
      }),
    );
  }

  @Action(DismissAdminUsersNotice)
  dismissNotice(ctx: StateContext<AdminUsersStateModel>): void {
    ctx.patchState({ notice: null });
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Shared activate/deactivate path: PATCH {status}, then the row is
   * replaced in place. Deactivation revokes the user's sessions
   * server-side immediately (backend guarantee, auth/03).
   */
  private toggleActive(
    ctx: StateContext<AdminUsersStateModel>,
    id: string,
    active: boolean,
  ): Observable<AdminUser> {
    ctx.patchState({ updating: true, updateError: null });
    return this.api
      .updateUser(id, { status: active ? 'active' : 'disabled' })
      .pipe(
        tap({
          next: (user) => {
            ctx.patchState({
              updating: false,
              updateError: null,
              users: ctx
                .getState()
                .users.map((u) => (u.id === user.id ? user : u)),
              notice: {
                kind: 'success',
                message: active
                  ? `${user.email} reactivated.`
                  : `${user.email} deactivated — signed out everywhere.`,
              },
            });
          },
          error: (err: { message?: string }) => {
            ctx.patchState({
              updating: false,
              updateError:
                err?.message ?? 'Could not change the user. Please try again.',
            });
          },
        }),
      );
  }
}

export const adminUsersStateProvider = provideStates([AdminUsersState]);
