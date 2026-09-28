/**
 * Admin auth actions (auth/02).
 *
 * All admin session state lives in AdminAuthState — components dispatch and
 * render selectors, never call the API directly. Mirrors the builder
 * portal's action set (embed/09).
 *
 * The legacy magic-link `VerifyAdminToken` action was removed 2026-09-28
 * (Karan retired the admin magic-link flow): Entra sign-in is the only
 * admin sign-in.
 */

/** Probes the current admin session (bearer token). */
export class LoadAdminSession {
  static readonly type = '[Admin Auth] Load session';
}

/**
 * Exits view-as on the session (auth/04). Display-only affordance — the
 * backend clears the session's view-as state and the session is re-probed.
 */
export class ExitViewAs {
  static readonly type = '[Admin Auth] Exit view as';
}

/** Ends the admin session (logout). */
export class LogoutAdmin {
  static readonly type = '[Admin Auth] Logout';
}

/** Resets all admin auth state (after logout or failed verify). */
export class ClearAdminAuth {
  static readonly type = '[Admin Auth] Clear auth';
}

/**
 * Completes an Entra External ID sign-in (auth/02 pivot, AUTH-02).
 *
 * Dispatched by `/admin/auth/callback` after the backend
 * `POST /api/v1/admin/auth/entra/callback` redeems the authorization code
 * and returns our session. Bootstraps NGXS auth state (session token +
 * identity) exactly like the legacy sign-in success path did.
 */
export class CompleteEntraSignIn {
  static readonly type = '[Admin Auth] Complete Entra sign in';
  constructor(
    public readonly sessionToken: string,
    public readonly email: string,
    public readonly name: string,
    public readonly staffRole: string,
  ) {}
}

/** Records a failed Entra callback exchange (classified for the callback page copy). */
export class FailEntraSignIn {
  static readonly type = '[Admin Auth] Fail Entra sign in';
  constructor(public readonly error: import('./admin-auth.state').EntraCallbackErrorKind) {}
}
