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
