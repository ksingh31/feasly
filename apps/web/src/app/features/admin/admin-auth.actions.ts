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
 * Signs in with email + password (auth/02, AUTH-02 frontend).
 *
 * CONTRACT-DRIVEN: handled by AdminAuthState against the
 * `POST /api/v1/admin/auth/login` contract; the backend route lands
 * separately. On success the state stores the session token + identity;
 * on failure it classifies the error for the login page's inline copy
 * (401 → invalid credentials, 429 → rate-limited).
 */
export class LoginAdminWithPassword {
  static readonly type = '[Admin Auth] Login with password';
  constructor(
    public readonly email: string,
    public readonly password: string,
    public readonly rememberMe: boolean,
  ) {}
}
