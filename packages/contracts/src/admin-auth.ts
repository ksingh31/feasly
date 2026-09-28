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
  /**
   * auth/04: the session's authorization context. Optional so older
   * backends stay compatible; the admin shell uses it for the view-as
   * banner and the org switcher.
   */
  readonly authContext?: {
    readonly userId: string | null;
    readonly name: string;
    readonly staffRole: 'super_admin' | 'admin' | 'viewer' | null;
    readonly permissions: readonly string[];
    readonly builderId: string | null;
    readonly builderName: string | null;
    readonly memberships: ReadonlyArray<{
      readonly builderId: string;
      readonly role: 'builder_admin' | 'builder_member';
    }>;
    readonly viewAs: {
      readonly builderId?: string;
      readonly userId?: string;
    } | null;
    readonly realUser: {
      readonly userId: string | null;
      readonly email: string;
      readonly name: string;
    } | null;
  };
}

export interface AdminAuthLogoutResponse {
  readonly loggedOut: true;
  /** The clearing Set-Cookie header value the adapter must emit. */
  readonly setCookie: string;
  /**
   * Entra end-session endpoint, or null when Entra is unprovisioned.
   * The frontend navigates here (full page, appending
   * `?post_logout_redirect_uri={app}/admin/login`) after clearing local
   * state — without this the Entra cookie survives and the next "Sign in"
   * silently re-authenticates (Karan, 2026-09-28).
   */
  readonly entraLogoutUrl: string | null;
  /**
   * The Entra id_token captured at sign-in, or null. The frontend passes
   * this as `id_token_hint` on the end-session redirect so Entra ends the
   * right session directly instead of showing the "Pick an account" picker
   * (logout UX, 2026-09-28).
   */
  readonly entraIdTokenHint: string | null;
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

/**
 * View-as contracts (auth/04).
 *
 * `super_admin` / `admin` holders (anyone with the `view_as` permission)
 * can view the product as a builder org or as another user. While active,
 * effective permissions + tenant scoping resolve to the target's; every
 * activation and exit is audit-logged under the REAL admin's identity.
 */

/** `POST /api/v1/admin/view-as` request body — exactly one target. */
export type AdminViewAsRequestBody =
  | { readonly builderId: string }
  | { readonly userId: string };

/** `POST /api/v1/admin/view-as` + `DELETE /api/v1/admin/view-as` response. */
export interface AdminViewAsResponse {
  readonly active: boolean;
  /** Present while view-as is active (echo of the target). */
  readonly target?: {
    readonly kind: 'builder' | 'user';
    readonly id: string;
    readonly displayName: string;
  };
}

/** `POST /api/v1/admin/auth/switch-builder` request body. */
export interface AdminSwitchBuilderRequestBody {
  /** Must be one of the caller's builder memberships — else 403. */
  readonly builderId: string;
}

/** `POST /api/v1/admin/auth/switch-builder` response. */
export interface AdminSwitchBuilderResponse {
  readonly builderId: string;
}
