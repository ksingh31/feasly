/**
 * Admin auth actions (admin/01).
 *
 * All admin session state lives in AdminAuthState — components dispatch and
 * render selectors, never call the API directly. Mirrors the builder
 * portal's action set (embed/09).
 */

/** Verifies an admin magic-link token (from the email URL). */
export class VerifyAdminToken {
  static readonly type = '[Admin Auth] Verify token';
  constructor(public readonly token: string) {}
}

/** Probes the current admin session (bearer token). */
export class LoadAdminSession {
  static readonly type = '[Admin Auth] Load session';
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
 * identity) exactly like the password/magic-link success paths did.
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
