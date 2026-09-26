/**
 * Builder portal contracts (embed/09).
 *
 * Builder-facing lead pipeline dashboard: magic-link + allowlist session
 * auth (same 7-day expiry as admin/01), tenant-scoped lead listing, and
 * pipeline status updates. The session travels as an httpOnly cookie
 * (never in these shapes); the client only ever sees the opaque magic-link
 * token from the email URL.
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
   * The raw session token, for the Function adapter to place in the
   * Set-Cookie header. The adapter strips this from the JSON body before
   * responding — it never reaches the browser as JSON.
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
