import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { AdminAuthApiService } from './admin-auth-api.service';
import {
  ClearAdminAuth,
  LoadAdminSession,
  LogoutAdmin,
  VerifyAdminToken,
} from './admin-auth.actions';

/** Auth lifecycle for the admin area. */
export type AdminAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

/**
 * Classification of the last VerifyAdminToken failure, so the verify page
 * can show the right error copy instead of one generic message.
 * - 'used': the single-use token was already consumed (re-click / prefetch).
 * - 'transient': network timeout, 5xx — safe to retry the same token.
 * - 'invalid': unknown, expired or revoked token.
 */
export type VerifyErrorKind = 'used' | 'transient' | 'invalid';

export interface AdminAuthStateModel {
  /**
   * The admin session token (from the verify JSON body). Sent back as
   * `Authorization: Bearer <token>` by the credentials interceptor.
   * Persisted via the NGXS storage plugin so the admin session survives a
   * reload — the cross-origin session cookie never sticks on modern
   * browsers, so without persistence every reload would bounce to login.
   */
  sessionToken: string | null;
  /** Lowercased admin email the session was issued for (display only). */
  email: string | null;
  authStatus: AdminAuthStatus;
  /** True when the last /me probe failed with SESSION_EXPIRED (login copy). */
  sessionExpired: boolean;
  /**
   * Classification of the last VerifyAdminToken failure (null when the last
   * verify succeeded or none has run). Read by the verify page's error state.
   */
  lastVerifyError: VerifyErrorKind | null;
}

const defaults: AdminAuthStateModel = {
  sessionToken: null,
  email: null,
  authStatus: 'unknown',
  sessionExpired: false,
  lastVerifyError: null,
};

/**
 * Maps a verify failure onto the error kind the verify page renders.
 * The API service already normalizes failures to the ApiError envelope
 * (`toApiError`): `retryable` covers timeouts, network failures and 5xx;
 * the backend returns code `MAGIC_LINK_USED` for consumed single-use
 * tokens. Anything else (unknown/expired/revoked token) is 'invalid'.
 */
function classifyVerifyError(error: unknown): VerifyErrorKind {
  if (typeof error === 'object' && error !== null) {
    const { code, retryable } = error as { code?: unknown; retryable?: unknown };
    if (retryable === true) return 'transient';
    if (code === 'MAGIC_LINK_USED') return 'used';
  }
  return 'invalid';
}

/**
 * Admin auth state (admin/01): the single source of truth for the
 * `/admin/*` session. Mirrors the builder portal's auth slice (embed/09).
 *
 * Only the token + email + status flags live here — no admin data — so
 * the whole slice is safe to persist. Admin DATA states (leads,
 * calibration, sheets-sync) stay memory-only and refetch on mount.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription.
 */
@State<AdminAuthStateModel>({
  name: 'adminAuth',
  defaults,
})
@Injectable()
export class AdminAuthState {
  private readonly authApi = inject(AdminAuthApiService);

  @Selector()
  static sessionToken(state: AdminAuthStateModel): string | null {
    return state.sessionToken;
  }

  @Selector()
  static email(state: AdminAuthStateModel): string | null {
    return state.email;
  }

  @Selector()
  static authStatus(state: AdminAuthStateModel): AdminAuthStatus {
    return state.authStatus;
  }

  @Selector()
  static sessionExpired(state: AdminAuthStateModel): boolean {
    return state.sessionExpired;
  }

  @Selector()
  static lastVerifyError(state: AdminAuthStateModel): VerifyErrorKind | null {
    return state.lastVerifyError;
  }

  @Selector()
  static authenticated(state: AdminAuthStateModel): boolean {
    return state.authStatus === 'authenticated';
  }

  @Action(VerifyAdminToken)
  verifyAdminToken(
    ctx: StateContext<AdminAuthStateModel>,
    action: VerifyAdminToken,
  ): Observable<unknown> {
    return this.authApi.verifyMagicLink(action.token).pipe(
      tap((identity) => {
        ctx.patchState({
          sessionToken: identity.sessionToken,
          email: identity.email,
          authStatus: 'authenticated',
          sessionExpired: false,
          lastVerifyError: null,
        });
      }),
      catchError((error: unknown) => {
        ctx.patchState({
          sessionToken: null,
          email: null,
          authStatus: 'unauthenticated',
          lastVerifyError: classifyVerifyError(error),
        });
        return of(null);
      }),
    );
  }

  @Action(LoadAdminSession)
  loadAdminSession(ctx: StateContext<AdminAuthStateModel>): Observable<unknown> {
    return this.authApi.me().pipe(
      tap((identity) => {
        ctx.patchState({
          email: identity.email,
          authStatus: 'authenticated',
          sessionExpired: false,
        });
      }),
      catchError((error: unknown) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code: unknown }).code
            : null;
        ctx.patchState({
          sessionToken: null,
          email: null,
          authStatus: 'unauthenticated',
          sessionExpired: code === 'SESSION_EXPIRED',
        });
        return of(null);
      }),
    );
  }

  @Action(LogoutAdmin)
  logoutAdmin(ctx: StateContext<AdminAuthStateModel>): Observable<unknown> {
    return this.authApi.logout().pipe(
      tap(() => ctx.setState({ ...defaults })),
      catchError(() => {
        // Even if the server call fails, drop the local token — the guard
        // re-probes on next navigation and fails closed.
        ctx.setState({ ...defaults });
        return of(null);
      }),
    );
  }

  @Action(ClearAdminAuth)
  clearAdminAuth(ctx: StateContext<AdminAuthStateModel>): void {
    ctx.setState({ ...defaults });
  }
}
