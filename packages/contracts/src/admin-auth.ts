/**
 * Admin auth contracts (auth/02).
 *
 * Microsoft Entra External ID is the only admin sign-in (the legacy
 * magic-link flow was retired 2026-09-28, Karan). The session token is
 * returned in the callback JSON body: the SPA stores it and sends it back
 * as `Authorization: Bearer <token>` (the cross-origin session cookie
 * never sticks on modern browsers). The logout adapter additionally emits
 * a clearing `Set-Cookie`.
 */

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
 * Microsoft Entra External ID sign-in contracts (auth/02 pivot — AUTH-02,
 * MVP). The SPA never touches Entra tokens: it redirects to the
 * Microsoft-hosted authorize endpoint with PKCE, and the callback route
 * hands the authorization `code` + PKCE verifier to the backend
 * `POST /api/v1/admin/auth/entra/callback`, which redeems the code with
 * Entra and mints our session.
 *
 * CONTRACT-DRIVEN: the backend route lands separately (backend half of
 * auth/02). The frontend codes against this shape; the backend must honor
 * it. Do not change these field names without updating the frontend.
 */

/** `POST /api/v1/admin/auth/entra/callback` request body. */
export interface AdminEntraCallbackBody {
  /** Authorization code from the Entra redirect (`?code=…`). */
  readonly code: string;
  /** PKCE `code_verifier` generated before the authorize redirect. */
  readonly codeVerifier: string;
  /** Must byte-match the `redirect_uri` sent in the authorize request. */
  readonly redirectUri: string;
}

/** `POST /api/v1/admin/auth/entra/callback` success response. */
export interface AdminEntraCallbackResponse {
  readonly authenticated: true;
  /** Identity of the signed-in admin (from Entra claims). */
  readonly user: {
    /** Lowercased admin email. */
    readonly email: string;
    /** Display name. */
    readonly name: string;
    /**
     * `super_admin` | `admin` | `viewer` | `builder_admin` |
     * `builder_member` (auth/01 roles).
     */
    readonly staffRole: string;
  };
  /**
   * The raw session token — the SPA stores it and sends it back as
   * `Authorization: Bearer <token>` (cross-origin cookie never sticks).
   */
  readonly sessionToken: string;
}
