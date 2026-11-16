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
import type { LeadCallbackSummary } from './callback';

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
  /**
   * Issue #530: true when the lead is won but no signed contract is
   * recorded yet (status 'won' and no commission invoice). Drives the
   * admin "Needs recording" item. Derived server-side — the portal never
   * recomputes it.
   */
  readonly needsRecording: boolean;
  /**
   * #836: the newest callback request on this lead (preferred day, time
   * window, notes), null when none. Optional for older backends.
   */
  readonly latestCallback?: LeadCallbackSummary | null;
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
  readonly summary: BuilderLeadStatusCounts & {
    /** Issue #530: won leads with no recorded contract (needsRecording). */
    readonly needsRecording: number;
  };
  /**
   * #721: leads Feasly moved away from this builder, newest first. The API
   * always sends it; optional only so older portal builds keep compiling.
   */
  readonly reassigned?: readonly BuilderReassignedLead[];
}

/** Per-status lead counts for the portal's segmented pipeline filter. */
export interface BuilderLeadStatusCounts {
  readonly total: number;
  readonly new: number;
  readonly contacted: number;
  readonly quoted: number;
  readonly won: number;
  readonly lost: number;
}

/**
 * One row in the Leads home "Needs you" section (phase 3 portal redesign).
 * A slim lead projection — the full list item (invoice, notes) comes from
 * `GET /api/v1/builder/leads`.
 */
export interface BuilderLeadNeedsYouItem {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly timeline: string;
  readonly leadScore: number;
  readonly status: BuilderLeadStatus;
  readonly addressKey: string;
  /** ISO-8601 — when the lead arrived. */
  readonly createdAt: string;
  /**
   * ISO-8601 — the last pipeline status change (from the status history),
   * or `createdAt` when the status never changed.
   */
  readonly statusChangedAt: string;
  /**
   * ISO-8601 anchor for the row's age label ("2h ago"): `createdAt` for
   * uncontacted leads, `statusChangedAt` for stale and won leads.
   */
  readonly waitingSince: string;
}

/**
 * `GET /api/v1/builder/leads/needs-you` — the Leads home "Needs you"
 * groups plus pipeline counts. Grouping, sorting and counting all happen
 * server-side. Each group is sorted by `leadScore` (highest first), then by
 * `waitingSince` (oldest first). A lead appears in at most one group.
 */
export interface BuilderLeadsNeedsYouResponse {
  /** status `new` — not contacted yet. */
  readonly uncontacted: readonly BuilderLeadNeedsYouItem[];
  /** status `contacted` or `quoted`, no status change in `staleAfterDays`+ days. */
  readonly stale: readonly BuilderLeadNeedsYouItem[];
  /** status `won` with no recorded contract (no commission invoice). */
  readonly wonWithoutContract: readonly BuilderLeadNeedsYouItem[];
  /** The staleness threshold the `stale` group used (server config). */
  readonly staleAfterDays: number;
  /** Status counts for the segmented filter (All · New · … · Lost). */
  readonly counts: BuilderLeadStatusCounts;
}

export interface BuilderLeadStatusUpdateBody {
  readonly status: BuilderLeadStatus;
}

/**
 * Issue #530 — `POST /api/v1/builder/leads/{id}/mark-won` response.
 *
 * Any org member (builder_member or builder_admin) can mark a lead won.
 * Recording the signed contract (which creates the commission invoice)
 * stays admin-only (`builder:billing`); marking won flags the lead as
 * "Needs recording" and emails the org's admins.
 */
export interface BuilderLeadMarkWonResponse {
  readonly ok: true;
  readonly status: 'won';
  /** Always true — a lead with a recorded contract is rejected with 409. */
  readonly needsRecording: true;
  /** False when the lead was already won (idempotent, no re-notify). */
  readonly changed: boolean;
  /** How many admin notification emails were sent (best-effort). */
  readonly adminsNotified: number;
}

/**
 * Builder management contracts (embed/02 admin-UI migration).
 *
 * The `builders` table is the runtime source of truth for builder config.
 * `tenantKey` is the builder ID used everywhere (embed config, sessions,
 * billing joins). Only admins manage these rows.
 */

/**
 * Builder lifecycle status (#860). What each status allows (embed, new
 * leads, sign-in, invoices, auto-charge, API keys) is the policy matrix in
 * {@link BUILDER_STATUS_POLICY}. Legacy `inactive` rows were migrated to
 * `suspended`.
 */
export type BuilderStatus = 'active' | 'suspended' | 'offboarding' | 'offboarded';

export const BUILDER_STATUSES: readonly BuilderStatus[] = [
  'active',
  'suspended',
  'offboarding',
  'offboarded',
];

/** One capability gated by builder status (#860). */
export type BuilderCapability =
  /** The embed config serves (the widget loads on the builder's site). */
  | 'embed'
  /** New leads are routed to the builder (otherwise: admin unassigned queue). */
  | 'newLeads'
  /** Team members can sign in to the builder portal. */
  | 'signIn'
  /** Read the portal: leads, comments, billing overview. */
  | 'portalRead'
  /** Change things in the portal: lead status, mark won, comments, payment method. */
  | 'portalWrite'
  /** View invoices in the portal. */
  | 'viewInvoices'
  /** Pay invoices (portal or pay-now link — no card needed). */
  | 'payInvoices'
  /** The invoice reviewer may auto-charge the saved card. */
  | 'autoCharge'
  /** API keys bound to the builder authenticate. */
  | 'apiKeys';

/**
 * The builder status policy matrix (#860) — the ONE place that decides what
 * a status allows. Every enforcement point calls `builderStatusAllows`.
 *
 * - suspended (frozen): no embed, no new leads, portal read-only, invoices
 *   viewable and payable, auto-charge and retries paused, API keys refused.
 * - offboarding: winding down — existing leads can still be worked and
 *   invoices settled (auto-charge continues so open invoices clear), but no
 *   embed, no new leads and no API keys.
 * - offboarded: relationship ended — no portal access; tail invoices (12
 *   months on already-introduced leads) are paid by pay-now link.
 */
export const BUILDER_STATUS_POLICY: Readonly<
  Record<BuilderStatus, Readonly<Record<BuilderCapability, boolean>>>
> = {
  active: {
    embed: true,
    newLeads: true,
    signIn: true,
    portalRead: true,
    portalWrite: true,
    viewInvoices: true,
    payInvoices: true,
    autoCharge: true,
    apiKeys: true,
  },
  suspended: {
    embed: false,
    newLeads: false,
    signIn: true,
    portalRead: true,
    portalWrite: false,
    viewInvoices: true,
    payInvoices: true,
    autoCharge: false,
    apiKeys: false,
  },
  offboarding: {
    embed: false,
    newLeads: false,
    signIn: true,
    portalRead: true,
    portalWrite: true,
    viewInvoices: true,
    payInvoices: true,
    autoCharge: true,
    apiKeys: false,
  },
  offboarded: {
    embed: false,
    newLeads: false,
    signIn: false,
    portalRead: false,
    portalWrite: false,
    viewInvoices: false,
    payInvoices: true,
    autoCharge: false,
    apiKeys: false,
  },
};

/** Admin lifecycle actions (#860). Each needs a reason and is audit-logged. */
export type BuilderLifecycleAction =
  | 'suspend'
  | 'reactivate'
  | 'start_offboarding'
  | 'complete_offboarding';

/** `POST /api/v1/admin/builders/{id}/status` body (#860). */
export interface BuilderLifecycleBody {
  readonly action: BuilderLifecycleAction;
  /** Mandatory, 3–1000 characters. Stored on the builder and in the audit row. */
  readonly reason: string;
}

/** One thing that blocks "complete offboarding" (#860). */
export interface BuilderOffboardingBlocker {
  readonly kind: 'unpaid_invoice' | 'open_dispute';
  /** Invoice id (both kinds name the invoice). */
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  /** Invoice status, or the dispute status for `open_dispute`. */
  readonly status: string;
}

/** `POST /api/v1/admin/builders/{id}/status` response (#860). */
export interface BuilderLifecycleResponse {
  readonly builder: Builder;
  /** False when the builder was already in the target status (idempotent). */
  readonly changed: boolean;
  /** Present for `complete_offboarding`: what was revoked/detached. */
  readonly offboarding?: {
    readonly sessionsRevoked: number;
    readonly apiKeysRevoked: number;
    readonly cardDetached: boolean;
  };
}

/** `GET /api/v1/admin/builders/{id}/export.csv?kind=` (#860). */
export type BuilderExportKind = 'leads' | 'invoices';

/** `POST /api/v1/builder/account/close-request` body (#860). */
export interface BuilderAccountClosureBody {
  /** Optional note for Feasly staff, up to 1000 characters. */
  readonly reason?: string;
}

/** `POST /api/v1/builder/account/close-request` response (#860). */
export interface BuilderAccountClosureResponse {
  readonly requestId: string;
  /** False when an open closure request already existed (idempotent). */
  readonly created: boolean;
  readonly requestedAt: string;
}

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
  /**
   * Why the status last changed (#860). Null before any lifecycle change.
   * Always sent by the API; optional on the type for older fixtures.
   */
  readonly statusReason?: string | null;
  /** When the status last changed (ISO). Null before any lifecycle change. */
  readonly statusChangedAt?: string | null;
  /** Admin email that last changed the status. Null before any lifecycle change. */
  readonly statusChangedBy?: string | null;
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
 * `POST /api/v1/admin/leads/{id}/assign-builder` response (#721).
 *
 * Moving a lead away from a builder closes that builder's open attribution
 * (nothing stays billable to them — owner decision 2026-11-15) and, when the
 * lead moves to another builder, opens a fresh introduction for the new
 * builder dated now. A lead with any non-void commission invoice is refused
 * with 409 `LEAD_HAS_INVOICE`; the message names the invoice, and the admin
 * must void or refund it first.
 */
export interface LeadAssignBuilderResponse {
  readonly ok: true;
  /** False when the lead was already assigned to the requested builder. */
  readonly changed: boolean;
  /** Builder the lead was assigned to before the call (null = unassigned). */
  readonly fromBuilderId: string | null;
  /** Builder the lead is assigned to now (null = unassigned). */
  readonly toBuilderId: string | null;
}

/**
 * A lead Feasly moved away from this builder (#721). The portal shows it
 * marked "Reassigned by Feasly", with no reason given. Only the name is
 * included: the builder no longer has access to the lead's contact details,
 * detail view or comments (those return 404).
 */
export interface BuilderReassignedLead {
  readonly id: string;
  readonly name: string;
  /** ISO-8601: when the lead was moved away from this builder. */
  readonly reassignedAt: string;
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
  /** ISO-8601 when the user row was created (invite sent). Additive (#535). */
  readonly createdAt?: string;
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
