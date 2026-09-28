import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { AdminAuthApiService } from './admin-auth-api.service';
import { AdminEntraAuthService } from './admin-entra-auth.service';
import {
  ClearAdminAuth,
  CompleteEntraSignIn,
  ExitViewAs,
  FailEntraSignIn,
  LoadAdminSession,
  LogoutAdmin,
} from './admin-auth.actions';

/** Auth lifecycle for the admin area. */
export type AdminAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

/**
 * Classification of the last Entra callback failure, so the callback page
 * can show the right buyer-grade copy (auth/02 pivot):
 * - 'cancelled': Entra reported `error=access_denied` (the user cancelled)
 *   or the callback carried no usable authorization code.
 * - 'state-mismatch': the `state` param didn't match what we stored before
 *   the redirect (possible CSRF — never the user's fault to fix).
 * - 'transient': network timeout, 5xx exchanging the code — safe to retry
 *   from `/admin/login`.
 */
export type EntraCallbackErrorKind = 'cancelled' | 'state-mismatch' | 'transient';

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
   * Classification of the last Entra callback failure (null when the last
   * callback succeeded or none has run). Read by the callback page.
   */
  lastEntraError: EntraCallbackErrorKind | null;
  /**
   * auth/04: view-as state from the /me authorization context. Display
   * only — the backend is authoritative. Null when not viewing-as.
   */
  viewAs: { builderId?: string; userId?: string } | null;
  /** Display name for the view-as banner ("Viewing as X"). */
  viewAsDisplayName: string | null;
  /** The real admin's email, for the banner's audit note. */
  viewAsRealEmail: string | null;
  /** Session's effective permissions (display only). */
  permissions: string[];
  /** Active builder tenant name (org switcher display). */
  activeBuilderName: string | null;
}

const defaults: AdminAuthStateModel = {
  sessionToken: null,
  email: null,
  name: null,
  staffRole: null,
  authStatus: 'unknown',
  sessionExpired: false,
  lastEntraError: null,
  viewAs: null,
  viewAsDisplayName: null,
  viewAsRealEmail: null,
  permissions: [],
  activeBuilderName: null,
};

/**
 * Admin auth state (auth/02): the single source of truth for the
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
  private readonly entraAuth = inject(AdminEntraAuthService);

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
  static lastEntraError(state: AdminAuthStateModel): EntraCallbackErrorKind | null {
    return state.lastEntraError;
  }

  @Selector()
  static authenticated(state: AdminAuthStateModel): boolean {
    return state.authStatus === 'authenticated';
  }

  /** auth/04: true while the session is viewing-as another target. */
  @Selector()
  static viewingAs(state: AdminAuthStateModel): boolean {
    return state.viewAs !== null;
  }

  /** auth/04: banner copy inputs, null when not viewing-as. */
  @Selector()
  static viewAsBanner(
    state: AdminAuthStateModel,
  ): { displayName: string; realEmail: string } | null {
    if (!state.viewAs || !state.viewAsDisplayName) return null;
    return {
      displayName: state.viewAsDisplayName,
      realEmail: state.viewAsRealEmail ?? '',
    };
  }

  @Action(LoadAdminSession)
  loadAdminSession(ctx: StateContext<AdminAuthStateModel>): Observable<unknown> {
    return this.authApi.me().pipe(
      tap((identity) => {
        // auth/04: the /me authorization context drives the view-as
        // banner and org switcher (display only — backend authoritative).
        const authCtx = identity.authContext;
        const viewAs = authCtx?.viewAs ?? null;
        const viewAsDisplayName = viewAs
          ? (viewAs.builderId
              ? (authCtx?.builderName ?? viewAs.builderId)
              : (authCtx?.name ?? viewAs.userId ?? ''))
          : null;
        ctx.patchState({
          email: identity.email,
          name: authCtx?.name ?? null,
          staffRole: authCtx?.staffRole ?? null,
          authStatus: 'authenticated',
          sessionExpired: false,
          viewAs,
          viewAsDisplayName,
          viewAsRealEmail: authCtx?.realUser?.email ?? null,
          permissions: authCtx ? [...authCtx.permissions] : [],
          activeBuilderName: authCtx?.builderName ?? null,
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
          viewAs: null,
          viewAsDisplayName: null,
          viewAsRealEmail: null,
          permissions: [],
          activeBuilderName: null,
        });
        return of(null);
      }),
    );
  }

  @Action(CompleteEntraSignIn)
  completeEntraSignIn(
    ctx: StateContext<AdminAuthStateModel>,
    action: CompleteEntraSignIn,
  ): void {
    ctx.patchState({
      sessionToken: action.sessionToken,
      email: action.email,
      name: action.name,
      staffRole: action.staffRole,
      authStatus: 'authenticated',
      sessionExpired: false,
      lastEntraError: null,
    });
  }

  @Action(FailEntraSignIn)
  failEntraSignIn(
    ctx: StateContext<AdminAuthStateModel>,
    action: FailEntraSignIn,
  ): void {
    ctx.patchState({
      sessionToken: null,
      email: null,
      name: null,
      staffRole: null,
      authStatus: 'unauthenticated',
      lastEntraError: action.error,
    });
  }

  @Action(LogoutAdmin)
  logoutAdmin(ctx: StateContext<AdminAuthStateModel>): Observable<unknown> {
    return this.authApi.logout().pipe(
      tap((res) => {
        ctx.setState({ ...defaults });
        // Kill the Entra IdP session too: without the end-session
        // redirect the Entra cookie survives and the next "Sign in"
        // silently re-authenticates (Karan, 2026-09-28). Null when
        // Entra is unprovisioned — then there is no IdP session.
        // The id_token_hint skips Entra's "Pick an account" picker so the
        // sign-out completes without the extra stop (logout UX, 2026-09-28).
        this.entraAuth.redirectToEntraLogout(
          res.entraLogoutUrl ?? null,
          res.entraIdTokenHint ?? null,
        );
      }),
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

  /**
   * auth/04: exit view-as. The backend clears the session's view-as state
   * (audit-logged under the real admin); the session is re-probed so the
   * banner disappears and permissions revert. Display-only affordance —
   * enforcement stays server-side.
   */
  @Action(ExitViewAs)
  exitViewAs(ctx: StateContext<AdminAuthStateModel>): Observable<unknown> {
    return this.authApi.exitViewAs().pipe(
      catchError(() => {
        // If the exit call fails, re-probe anyway: the guard fails closed
        // and the banner reflects the server's actual state.
        return of(null);
      }),
      // switchMap (not tap + nested dispatch) so the action completes only
      // after the /me refresh lands.
      switchMap(() => ctx.dispatch(new LoadAdminSession())),
    );
  }
}
