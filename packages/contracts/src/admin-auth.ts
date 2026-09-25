/**
 * Admin auth contracts (admin/01).
 *
 * Magic-link + allowlist session auth for the admin area. The session itself
 * travels as an httpOnly cookie (never in these shapes); the client only
 * ever sees the opaque magic-link token from the email URL.
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
   * The raw session token, for the Function adapter to place in the
   * Set-Cookie header. The adapter strips this from the JSON body before
   * responding — it never reaches the browser as JSON.
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
