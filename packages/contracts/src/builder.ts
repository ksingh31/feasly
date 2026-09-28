/**
 * Builder portal contracts (embed/09).
 *
 * Builder-facing lead pipeline dashboard: magic-link + allowlist session
 * auth (same 7-day expiry as admin/01), tenant-scoped lead listing, and
 * pipeline status updates. The session token is returned in the verify
 * JSON body: the SPA stores it and sends it back as
 * `Authorization: Bearer <token>` (the cross-origin session cookie never
 * sticks on modern browsers). The adapter additionally emits it as an
 * httpOnly `Set-Cookie` for a same-origin future. The client only ever
 * sees the opaque magic-link token from the email URL before that.
 */

export interface BuilderAuthRequestBody {
  readonly email: string;
}

export interface BuilderAuthRequestResponse {
  /**
   * Always true — the response is identical for allowlisted and
   * non-allowlisted emails (no enumeration oracle). The UI shows
   * "Check your email for your sign-in link." either way.
   */
  readonly sent: true;
}

export interface BuilderAuthVerifyResponse {
  readonly authenticated: true;
  /** Lowercased builder email the session was issued for. */
  readonly email: string;
  /** The tenant this builder session is authorized for. */
  readonly tenantKey: string;
  /**
   * The raw session token. Returned in the JSON body so the SPA can store
   * it and send it back as `Authorization: Bearer <token>` on builder
   * requests (the cross-origin session cookie is blocked by modern
   * browsers). The Function adapter ALSO places it in the Set-Cookie
   * header (kept for a same-origin future) and strips only `setCookie`
   * from the JSON body.
   */
  readonly sessionToken: string;
  /** The full Set-Cookie header value the adapter must emit. */
  readonly setCookie: string;
}

export interface BuilderAuthMeResponse {
  readonly authenticated: true;
  /** Lowercased builder email the session was issued for. */
  readonly email: string;
  /** The tenant this builder session is authorized for. */
  readonly tenantKey: string;
}

export interface BuilderAuthLogoutResponse {
  readonly loggedOut: true;
  /** The clearing Set-Cookie header value the adapter must emit. */
  readonly setCookie: string;
}

/** Pipeline statuses a builder can set on their leads. */
export type BuilderLeadStatus =
  | 'new'
  | 'contacted'
  | 'quoted'
  | 'won'
  | 'lost';

export interface BuilderLeadListItem {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly timeline: string;
  readonly leadScore: number;
  readonly status: BuilderLeadStatus;
  /** ISO-8601 timestamp of the last status change (or creation). */
  readonly statusUpdatedAt: string;
  readonly addressKey: string;
  readonly projectType: string;
  readonly createdAt: string;
}

export interface BuilderLeadListResponse {
  readonly leads: readonly BuilderLeadListItem[];
  readonly summary: {
    readonly total: number;
    readonly new: number;
    readonly contacted: number;
    readonly quoted: number;
    readonly won: number;
    readonly lost: number;
  };
}

export interface BuilderLeadStatusUpdateBody {
  readonly status: BuilderLeadStatus;
}

/**
 * Builder management contracts (embed/02 admin-UI migration).
 *
 * The `builders` table is the runtime source of truth for builder config.
 * `tenantKey` is the builder ID used everywhere (embed config, sessions,
 * billing joins). Only admins manage these rows.
 */

export type BuilderStatus = 'active' | 'inactive';

export interface Builder {
  readonly id: string;
  readonly tenantKey: string;
  readonly businessName: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly logoUrl: string | null;
  readonly accentColor: string | null;
  readonly allowedOrigins: readonly string[];
  /** 'flat' | 'commission' | null (undecided). */
  readonly plan: string | null;
  readonly status: BuilderStatus;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BuilderListResponse {
  readonly builders: readonly Builder[];
}

export interface BuilderCreateBody {
  readonly tenantKey: string;
  readonly businessName: string;
  readonly displayName: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly logoUrl?: string | null;
  readonly accentColor?: string | null;
  readonly allowedOrigins?: readonly string[];
  readonly plan?: string | null;
  readonly status?: BuilderStatus;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface BuilderUpdateBody {
  readonly businessName?: string;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly logoUrl?: string | null;
  readonly accentColor?: string | null;
  readonly allowedOrigins?: readonly string[];
  readonly plan?: string | null;
  readonly status?: BuilderStatus;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface LeadAssignBuilderBody {
  /** Builder id to assign, or null to unassign. */
  readonly builderId: string | null;
}

/**
 * Builder Entra sign-in contracts (auth/05 — builder org accounts).
 *
 * The builder portal replaces magic-link auth with Microsoft Entra
 * External ID (email+password), mirroring the admin Entra flow. The
 * backend resolves the user's `builder_memberships` (not staff roles);
 * a user with no membership gets 403 with no enumeration.
 *
 * PLACEHOLDER (2026-09-28): the builder Entra External ID app
 * registration / user flow is not yet provisioned in the Azure portal
 * (like the admin flow needed). The backend codes against the expected
 * `builderEntraSignIn` config; the callback 503s fail-closed until Karan
 * provisions it.
 */

/** `POST /api/v1/builder/auth/entra/callback` request body. */
export interface BuilderEntraCallbackBody {
  /** Authorization code from the Entra redirect (`?code=…`). */
  readonly code: string;
  /** PKCE `code_verifier` generated before the authorize redirect. */
  readonly codeVerifier: string;
  /** Must byte-match the `redirect_uri` sent in the authorize request. */
  readonly redirectUri: string;
}

/** A builder org membership returned with the callback. */
export interface BuilderMembershipSummary {
  /** Builder row id (uuid). */
  readonly builderId: string;
  /** Builder tenant key (e.g. `elite-craft`). */
  readonly tenantKey: string;
  /** Display name of the builder org. */
  readonly builderName: string;
  /** `builder_admin` | `builder_member`. */
  readonly role: string;
}

/** `POST /api/v1/builder/auth/entra/callback` success response. */
export interface BuilderEntraCallbackResponse {
  readonly authenticated: true;
  /** Identity of the signed-in builder user (from Entra claims). */
  readonly user: {
    /** Lowercased builder email. */
    readonly email: string;
    /** Display name. */
    readonly name: string;
    /** All of the user's builder org memberships. */
    readonly memberships: readonly BuilderMembershipSummary[];
  };
  /**
   * The builder id of the org this session is scoped to (the active org —
   * first membership by default; switch via
   * `POST /api/v1/builder/auth/active-org`).
   */
  readonly activeBuilderId: string;
  /**
   * The raw session token — the SPA stores it and sends it back as
   * `Authorization: Bearer <token>` (cross-origin cookie never sticks).
   */
  readonly sessionToken: string;
}

/** `GET /api/v1/builder/auth/memberships` response. */
export interface BuilderMembershipsResponse {
  readonly memberships: readonly BuilderMembershipSummary[];
  /** The builder id of the org the current session is scoped to. */
  readonly activeBuilderId: string | null;
}

/** `POST /api/v1/builder/auth/active-org` request body. */
export interface BuilderActiveOrgBody {
  /** Builder id to make the session's active org. Must be a membership. */
  readonly builderId: string;
}

/** `POST /api/v1/builder/auth/active-org` response. */
export interface BuilderActiveOrgResponse {
  readonly activeBuilderId: string;
  readonly builderName: string;
}

/**
 * Builder org user-management contracts (auth/05).
 *
 * All routes are org-scoped via the session's active builder id
 * (`builder_admin` only). Roles are forced to builder roles; a
 * client-supplied builder id is ignored.
 */

/** A builder org member. */
export interface BuilderOrgUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** 'invited' | 'active' | 'disabled'. */
  readonly status: string;
  /** `builder_admin` | `builder_member`. */
  readonly role: string;
}

/** `GET /api/v1/builder/users` response. */
export interface BuilderOrgUserListResponse {
  readonly users: readonly BuilderOrgUser[];
}

/** `POST /api/v1/builder/users/invite` request body. */
export interface BuilderOrgUserInviteBody {
  readonly email: string;
  readonly name: string;
  /** `builder_admin` | `builder_member` (defaults to `builder_member`). */
  readonly role?: string;
}

/** `POST /api/v1/builder/users/invite` response. */
export interface BuilderOrgUserInviteResponse {
  readonly user: BuilderOrgUser;
  readonly emailSent: boolean;
}

/** `PATCH /api/v1/builder/users/{id}` request body. */
export interface BuilderOrgUserUpdateBody {
  readonly name?: string;
  /** `builder_admin` | `builder_member`. */
  readonly role?: string;
  /** 'active' | 'disabled' — disabling kills sessions immediately. */
  readonly status?: string;
}
