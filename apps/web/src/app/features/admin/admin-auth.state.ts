import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { AdminAuthApiService } from './admin-auth-api.service';
import {
  ClearAdminAuth,
  LoadAdminSession,
  LoginAdminWithPassword,
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

/**
 * Classification of the last password-login failure, so the login page can
 * show the right buyer-grade inline copy (auth/02):
 * - 'invalid-credentials': 401 INVALID_CREDENTIALS — wrong email or password
 *   (indistinguishable by design, no enumeration oracle).
 * - 'rate-limited': 429 TOO_MANY_ATTEMPTS — 5 attempts per 15 min.
 * - 'transient': network timeout, 5xx — safe to retry.
 */
export type LoginErrorKind =
  | 'invalid-credentials'
  | 'rate-limited'
  | 'transient';

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
  /**
   * Display name from the password-login identity (auth/02). Null for
   * legacy magic-link sessions until the backend enriches /me.
   */
  name: string | null;
  /**
   * Staff role from the password-login identity
   * (`super_admin` | `admin` | `viewer`). Null for legacy magic-link
   * sessions. Drives role-gated UI in later auth stories.
   */
  staffRole: string | null;
  authStatus: AdminAuthStatus;
  /** True when the last /me probe failed with SESSION_EXPIRED (login copy). */
  sessionExpired: boolean;
  /**
   * Classification of the last VerifyAdminToken failure (null when the last
   * verify succeeded or none has run). Read by the verify page's error state.
   */
  lastVerifyError: VerifyErrorKind | null;
  /**
   * Classification of the last LoginAdminWithPassword failure (null when
   * the last login succeeded or none has run). Read by the login page's
   * inline error. Cleared on every new login attempt.
   */
  lastLoginError: LoginErrorKind | null;
}

const defaults: AdminAuthStateModel = {
  sessionToken: null,
  email: null,
  name: null,
  staffRole: null,
  authStatus: 'unknown',
  sessionExpired: false,
  lastVerifyError: null,
  lastLoginError: null,
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
 * Maps a password-login failure onto the error kind the login page renders.
 * The API service normalizes failures to the ApiError envelope
 * (`toApiError`): `retryable` covers timeouts, network failures and 5xx;
 * the backend returns code `INVALID_CREDENTIALS` (401) for wrong
 * credentials and `TOO_MANY_ATTEMPTS` (429) for the rate limit.
 */
function classifyLoginError(error: unknown): LoginErrorKind {
  if (typeof error === 'object' && error !== null) {
    const { code, retryable } = error as { code?: unknown; retryable?: unknown };
    if (code === 'INVALID_CREDENTIALS') return 'invalid-credentials';
    if (code === 'TOO_MANY_ATTEMPTS') return 'rate-limited';
    if (retryable === true) return 'transient';
  }
  return 'transient';
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
  static name(state: AdminAuthStateModel): string | null {
    return state.name;
  }

  @Selector()
  static staffRole(state: AdminAuthStateModel): string | null {
    return state.staffRole;
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
  static lastLoginError(state: AdminAuthStateModel): LoginErrorKind | null {
    return state.lastLoginError;
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

  @Action(LoginAdminWithPassword)
  loginAdminWithPassword(
    ctx: StateContext<AdminAuthStateModel>,
    action: LoginAdminWithPassword,
  ): Observable<unknown> {
    // Clear the previous login error so a retry starts clean.
    ctx.patchState({ lastLoginError: null });
    return this.authApi
      .loginWithPassword({
        email: action.email,
        password: action.password,
        rememberMe: action.rememberMe,
      })
      .pipe(
        tap((response) => {
          ctx.patchState({
            sessionToken: response.sessionToken,
            email: response.user.email,
            name: response.user.name,
            staffRole: response.user.staffRole,
            authStatus: 'authenticated',
            sessionExpired: false,
            lastLoginError: null,
            lastVerifyError: null,
          });
        }),
        catchError((error: unknown) => {
          ctx.patchState({
            sessionToken: null,
            email: null,
            name: null,
            staffRole: null,
            authStatus: 'unauthenticated',
            lastLoginError: classifyLoginError(error),
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
