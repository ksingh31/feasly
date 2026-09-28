/**
 * Admin auth contracts (admin/01).
 *
 * Magic-link + allowlist session auth for the admin area. The session
 * token is returned in the verify JSON body: the SPA stores it and sends
 * it back as `Authorization: Bearer <token>` (the cross-origin session
 * cookie never sticks on modern browsers). The adapter additionally emits
 * it as an httpOnly `Set-Cookie` for a same-origin future. The client only
 * ever sees the opaque magic-link token from the email URL before that.
 */

export interface AdminAuthRequestBody {
  readonly email: string;
}

export interface AdminAuthRequestResponse {
  /**
   * Always true — the response is identical for allowlisted and
   * non-allowlisted emails (no enumeration oracle). The UI shows
   * "Check your email for your sign-in link." either way.
   */
  readonly sent: true;
}

export interface AdminAuthVerifyResponse {
  readonly authenticated: true;
  /** Lowercased admin email the session was issued for. */
  readonly email: string;
  /**
   * The raw session token. Returned in the JSON body so the SPA can store
   * it and send it back as `Authorization: Bearer <token>` on admin
   * requests (the cross-origin session cookie is blocked by modern
   * browsers). The Function adapter ALSO places it in the Set-Cookie
   * header (kept for a same-origin future) and strips only `setCookie`
   * from the JSON body.
   */
  readonly sessionToken: string;
  /** The full Set-Cookie header value the adapter must emit. */
  readonly setCookie: string;
}

export interface AdminAuthMeResponse {
  readonly authenticated: true;
  /** Lowercased admin email the session was issued for. */
  readonly email: string;
}

export interface AdminAuthLogoutResponse {
  readonly loggedOut: true;
  /** The clearing Set-Cookie header value the adapter must emit. */
  readonly setCookie: string;
}

/**
 * Password sign-in contracts (auth/02 — AUTH-02, MVP).
 *
 * CONTRACT-DRIVEN: the backend route lands separately (backend half of
 * auth/02). The frontend codes against this shape; the backend must honor
 * it. Do not change these field names without updating the frontend.
 */

/** `POST /api/v1/admin/auth/login` request body. */
export interface AdminPasswordLoginBody {
  readonly email: string;
  /** Plaintext password — TLS only, never logged, never persisted. */
  readonly password: string;
  /** True → 30-day session; false → 7-day session. */
  readonly rememberMe: boolean;
}

/** `POST /api/v1/admin/auth/login` success response. */
export interface AdminPasswordLoginResponse {
  readonly authenticated: true;
  /** Identity of the signed-in admin (never the password hash). */
  readonly user: {
    /** Lowercased admin email. */
    readonly email: string;
    /** Display name. */
    readonly name: string;
    /** `super_admin` | `admin` | `viewer` (auth/01 roles). */
    readonly staffRole: string;
  };
  /**
   * The raw session token — same discipline as the magic-link verify
   * response: the SPA stores it and sends it back as
   * `Authorization: Bearer <token>` (cross-origin cookie never sticks).
   */
  readonly sessionToken: string;
}

/**
 * Error codes the login route returns (auth/02):
 * - 401 `INVALID_CREDENTIALS` — wrong email or password (indistinguishable,
 *   no enumeration oracle).
 * - 429 `TOO_MANY_ATTEMPTS` — rate limit tripped (5 attempts / 15 min).
 */
export type AdminPasswordLoginErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'TOO_MANY_ATTEMPTS';

/** `POST /api/v1/admin/auth/forgot-password` request body. */
export interface AdminForgotPasswordBody {
  readonly email: string;
}

export interface AdminForgotPasswordResponse {
  /**
   * Always true — identical for known and unknown emails (no enumeration
   * oracle). The UI shows the "check your email" copy either way.
   */
  readonly sent: true;
}
