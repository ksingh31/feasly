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
