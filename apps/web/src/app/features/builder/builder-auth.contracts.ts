/**
 * Builder auth/05 contracts — FRONTEND-OWNED PLACEHOLDERS (auth/05,
 * builder org accounts).
 *
 * These mirror the `@feasly/contracts` pattern but live in the web app
 * because the backend half of auth/05 (Entra callback, org endpoints,
 * team routes) lands separately. The backend MUST honor these shapes;
 * once the backend contracts land in `@feasly/contracts`, these local
 * types should be replaced with imports (single source of truth).
 *
 * Field names are frozen — do not rename without updating both sides.
 */

/**
 * Classification of the last builder Entra callback failure, so the
 * callback page can show the right buyer-grade copy (mirrors the admin
 * `EntraCallbackErrorKind`):
 * - 'cancelled': Entra reported `error=access_denied` (the user cancelled)
 *   or the callback carried no usable authorization code.
 * - 'state-mismatch': the `state` param didn't match what we stored before
 *   the redirect (possible CSRF — never the user's fault to fix).
 * - 'transient': network timeout, 5xx exchanging the code — safe to retry
 *   from `/builder/login`.
 */
export type EntraCallbackErrorKind = 'cancelled' | 'state-mismatch' | 'transient';

/** A builder organization the signed-in user belongs to. */
export interface BuilderOrgMembership {  /** Builder id (tenant key). */
  readonly builderId: string;
  /** Display name of the organization. */
  readonly builderName: string;
  /** The user's role in this org. */
  readonly role: 'builder_admin' | 'builder_member';
}

/** `POST /api/v1/builder/auth/entra/callback` request body. */
export interface BuilderEntraCallbackBody {
  /** Authorization code from the Entra redirect (`?code=…`). */
  readonly code: string;
  /** PKCE `code_verifier` generated before the authorize redirect. */
  readonly codeVerifier: string;
  /** Must byte-match the `redirect_uri` sent in the authorize request. */
  readonly redirectUri: string;
}

/** `POST /api/v1/builder/auth/entra/callback` success response. */
export interface BuilderEntraCallbackResponse {
  readonly authenticated: true;
  /** Identity of the signed-in builder user (from Entra claims). */
  readonly user: {
    /** Lowercased email. */
    readonly email: string;
    /** Display name. */
    readonly name: string;
  };
  /** All builder orgs this user belongs to (may be empty → 403). */
  readonly memberships: readonly BuilderOrgMembership[];
  /**
   * The raw session token — the SPA stores it and sends it back as
   * `Authorization: Bearer <token>` (cross-origin cookie never sticks).
   */
  readonly sessionToken: string;
}

/** `GET /api/v1/builder/auth/memberships` response. */
export interface BuilderMembershipsResponse {
  readonly memberships: readonly BuilderOrgMembership[];
}

/** `POST /api/v1/builder/auth/switch-org` request body. */
export interface BuilderSwitchOrgBody {
  /** Must be one of the caller's memberships — else 403. */
  readonly builderId: string;
}

/** `POST /api/v1/builder/auth/switch-org` response. */
export interface BuilderSwitchOrgResponse {
  readonly builderId: string;
  readonly builderName: string;
}

/** Extended session identity (auth/05): active org + role + memberships. */
export interface BuilderSessionIdentity {
  readonly authenticated: true;
  readonly email: string;
  readonly name: string | null;
  /** Active org id (tenant key) — null until the org is chosen. */
  readonly builderId: string | null;
  readonly builderName: string | null;
  readonly role: 'builder_admin' | 'builder_member' | null;
  readonly memberships: readonly BuilderOrgMembership[];
}

/** A user in the builder's organization (team page). */
export interface BuilderTeamUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: 'builder_admin' | 'builder_member';
  readonly status: 'active' | 'invited' | 'deactivated';
  /** ISO-8601 when the invite was sent / user joined. */
  readonly createdAt: string;
}

/** `GET /api/v1/builder/users` response (org-scoped, newest first). */
export interface BuilderTeamListResponse {
  readonly users: readonly BuilderTeamUser[];
}

/** `POST /api/v1/builder/users/invite` request body. */
export interface BuilderTeamInviteBody {
  readonly name: string;
  readonly email: string;
  /** Forced to builder_admin | builder_member; builder id comes from the session. */
  readonly role: 'builder_admin' | 'builder_member';
}

/** `POST /api/v1/builder/users/invite` response. */
export interface BuilderTeamInviteResponse {
  readonly user: BuilderTeamUser;
  readonly emailSent: boolean;
}

/** `PATCH /api/v1/builder/users/{id}` request body. */
export interface BuilderTeamUpdateBody {
  readonly name?: string;
  readonly role?: 'builder_admin' | 'builder_member';
  /** Deactivate/reactivate. Deactivation kills the session immediately. */
  readonly status?: 'active' | 'deactivated';
}

/** `DELETE /api/v1/builder/users/{id}` response. */
export interface BuilderTeamDeleteResponse {
  readonly deleted: true;
}
