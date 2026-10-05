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
import type { BuilderPaymentMethod, CommissionInvoiceStatus } from './billing';

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
  /**
   * The user's role in the session's active org, resolved server-side from
   * the builder memberships. Null when the session has no active builder
   * membership (e.g. legacy magic-link sessions with no user record). The
   * builder frontend restores the active-org role from this on every
   * session load, so a stale client state can never hide the Team nav from
   * a builder_admin.
   */
  readonly role: 'builder_admin' | 'builder_member' | null;
  /**
   * Builder-side view-as state (2026-09-30, Karan): set while the session
   * is viewing-as an org team member. Drives the view-as banner + exit.
   * Display only; the backend stays authoritative.
   */
  readonly viewAs: { readonly userId: string } | null;
  /** Display name for the view-as banner ("Viewing the portal as X"). */
  readonly viewAsDisplayName: string | null;
  /**
   * The real signed-in user's email while viewing-as (null otherwise).
   * Shown in the banner so it's always clear who you really are.
   */
  readonly realEmail: string | null;
}

export interface BuilderAuthLogoutResponse {
  readonly loggedOut: true;
  /** The clearing Set-Cookie header value the adapter must emit. */
  readonly setCookie: string;
  /**
   * Entra end-session endpoint, or null when Entra is unprovisioned.
   * For the builder frontend to consume once builder Entra lands
   * (AUTH #74) — ignored until then (magic-link sessions have no IdP
   * session to kill).
   */
  readonly entraLogoutUrl: string | null;
  /**
   * The Entra id_token captured at sign-in, or null. Passed as
   * `id_token_hint` on the end-session redirect so Entra skips the
   * "Pick an account" picker (logout UX, 2026-09-28).
   */
  readonly entraIdTokenHint: string | null;
}

/** Pipeline statuses a builder can set on their leads. */
export type BuilderLeadStatus =
  | 'new'
  | 'contacted'
  | 'quoted'
  | 'won'
  | 'lost';

/**
 * Display-safe summary of the commission invoice for a recorded contract.
 * Lets the builder portal show "already recorded" state without fetching
 * the invoice list (picker filtering, lead-card CTA swap, already-recorded
 * card). No money math here — the invoice is the source of truth.
 */
export interface BuilderLeadInvoiceSummary {
  readonly id: string;
  /** Human-readable invoice number, e.g. "INV-0042". */
  readonly invoiceNumber: string;
  /** Signed construction contract value, integer cents, excl. land. */
  readonly contractValueCents: number;
  /** round(contractValueCents * rate), integer cents. */
  readonly commissionCents: number;
  readonly status: CommissionInvoiceStatus;
  /** draft created + 7 days — the builder's review/dispute window. */
  readonly reviewDueAt: string | null;
  /**
   * How this invoice gets paid (QA 2026-10-04): 'card' = Stripe
   * auto-charge after review; anything else = manual — the UI must not
   * promise a card charge or show an auto-charge countdown for manual
   * invoices.
   */
  readonly paymentMethod: BuilderPaymentMethod;
}

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
  /** True when a commission invoice exists for this lead (contract recorded). */
  readonly hasInvoice: boolean;
  /** Invoice summary when hasInvoice is true, null otherwise. */
  readonly invoiceSummary: BuilderLeadInvoiceSummary | null;
  /**
   * Builder-visible comment count (org + shared admin notes only —
   * admin_only and soft-deleted rows are excluded in SQL). Drives the
   * collapsed notes badge on each lead card; the thread pushes live
   * updates after load/post/edit.
   */
  readonly commentCount: number;
  /**
   * Newest builder-visible comment, null when commentCount is 0. Powers
   * the collapsed notes preview — one field set, no full thread fetch.
   */
  readonly latestComment: BuilderLeadCommentPreview | null;
}

/**
 * Builder-visible comment preview for the lead list: the newest
 * builder-visible (org + shared admin) note, or null when there are
 * none. A subset of `Comment` — the preview never needs ids,
 * visibility, or edit state.
 */
export interface BuilderLeadCommentPreview {
  readonly body: string;
  readonly authorDisplayName: string;
  readonly authorKind: CommentAuthorKind;
  /** ISO-8601 timestamp. */
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
  /**
   * Negotiated commission rate, in PERCENT (e.g. 1.5 = 1.5%). Defaults to
   * 1. Editable in the admin portal (billing/08). New commission invoices
   * snapshot this value at creation; changing it affects future invoices
   * only.
   */
  readonly commissionRatePercent: number;
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
  /**
   * Commission rate in PERCENT (0–10). Omitted = the 1% default.
   * Rejected with 400 INVALID_RATE outside 0–10.
   */
  readonly commissionRatePercent?: number;
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
  /**
   * Commission rate in PERCENT (0–10). Omitted = unchanged. Changing it
   * affects future invoices only; existing invoices keep their snapshot.
   * Rejected with 400 INVALID_RATE outside 0–10.
   */
  readonly commissionRatePercent?: number;
  /**
   * The builder org's default payment method for new invoices (billing/12).
   * Omitted = unchanged. Existing invoices keep the method they were
   * created with. Merged into `settings.defaultPaymentMethod`.
   */
  readonly defaultPaymentMethod?: BuilderPaymentMethod;
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

/**
 * Builder-side view-as contracts (2026-09-30, Karan).
 *
 * A `builder_admin` (the only builder role holding `view_as`) can view the
 * portal as a regular team member of their own org. While active, effective
 * permissions + tenant scoping resolve to the target's; every activation
 * and exit is audit-logged under the REAL builder admin's identity.
 */

/** `POST /api/v1/builder/view-as` request body — user targets only. */
export interface BuilderViewAsRequestBody {
  /**
   * The org team member to view the portal as. Must be a regular user
   * (never an admin) holding a membership in the caller's own org.
   */
  readonly userId: string;
}

/** `POST /api/v1/builder/view-as` + `DELETE /api/v1/builder/view-as` response. */
export interface BuilderViewAsResponse {
  readonly active: boolean;
  /** Present while view-as is active (echo of the target). */
  readonly target?: {
    readonly kind: 'user';
    readonly id: string;
    readonly displayName: string;
  };
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

/**
 * Lead comments (BILL-05) — FROZEN contract. BILL-06 (builder portal UI)
 * and BILL-07 (admin console UI) build against these shapes; do not
 * change them without coordinating both lanes.
 *
 * Visibility model:
 * - `org` — visible to the lead's builder org AND to admins.
 * - `admin_only` — visible to admins only. The builder read path excludes
 *   these rows in SQL (never in JS), so leaking one to a builder is
 *   unrepresentable in the builder response.
 *
 * v1 attaches comments to leads only, but `entityType`/`entityId` are
 * generic from day one so invoice comments (the future dispute thread)
 * reuse this table with zero migration.
 */

/** Who can see a comment. */
export type CommentVisibility = 'org' | 'admin_only';

/** Who wrote a comment. */
export type CommentAuthorKind = 'builder' | 'admin';

/** What a comment is attached to. v1: leads only. */
export type CommentEntityType = 'lead';

/**
 * A single comment. Builder and admin responses share this one base type —
 * no duplicated interfaces. Soft-deleted rows are never serialized, so
 * `deletedAt` is always null on the wire.
 */
export interface Comment {
  readonly id: string;
  readonly entityType: CommentEntityType;
  readonly entityId: string;
  readonly authorKind: CommentAuthorKind;
  readonly authorId: string;
  readonly authorDisplayName: string;
  readonly visibility: CommentVisibility;
  /**
   * Bodies go out pristine — the Angular SPA renders them with
   * interpolation, which is the single HTML-escaping layer. Render as
   * text, never as HTML.
   */
  readonly body: string;
  /** ISO-8601 timestamps. */
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True once the author has edited the body. */
  readonly edited: boolean;
  readonly deletedAt: null;
}

/** `GET …/comments` response — newest last (chronological thread). */
export interface CommentListResponse {
  readonly comments: readonly Comment[];
}

/**
 * `POST …/comments` request body. `visibility` is honored on the admin
 * path only (default `admin_only` — safe default); the builder path
 * forces `org` server-side and ignores any client-sent value.
 */
export interface CreateCommentBody {
  readonly body: string;
  readonly visibility?: CommentVisibility;
}

/** `PATCH …/comments/{commentId}` request body. Author-only. */
export interface UpdateCommentBody {
  readonly body: string;
}
