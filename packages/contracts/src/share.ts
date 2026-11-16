/**
 * Partner-share contracts. A share mints a fresh magic link scoped to the same
 * estimate — the partner gets their own link row, never the owner's token.
 */

export interface PartnerShareRequest {
  readonly reportToken: string;
  readonly partnerEmail: string;
}

export interface PartnerShareResponse {
  readonly sent: boolean;
  readonly sharedTo: string;
}

/**
 * Partner-share link verification (partner-share redemption).
 *
 * The partner's link carries a DIFFERENT token type than the owner's
 * magic link (magic-link purpose 'partner-share' vs 'lead') and is
 * verified on a dedicated path — GET /v1/shares/verify — never on the
 * owner magic-link verify endpoint. On success `reportToken` is the
 * presented partner token itself, which unlocks GET /v1/reports/{token}
 * (read-only view for the partner); `partnerEmail` names the recipient
 * the share was sent to — absent for a link-only share (#838), which has
 * no recipient.
 */
export interface PartnerShareVerifySuccess {
  readonly valid: true;
  readonly reportToken: string;
  readonly estimateId: string;
  readonly partnerEmail?: string;
}

export interface PartnerShareVerifyFailure {
  readonly valid: false;
  readonly reason: 'expired' | 'invalid';
}

export type PartnerShareVerifyResponse =
  | PartnerShareVerifySuccess
  | PartnerShareVerifyFailure;

/**
 * Link-only report shares (#838).
 *
 * The owner copies a signed, expiring, READ-ONLY report link instead of
 * emailing a partner. The link is a fresh partner-share magic link (random
 * 256-bit token, only its hash is stored) — never the owner's own token —
 * so it verifies on GET /v1/shares/verify and opens the report without
 * owner-only actions. All three endpoints take the OWNER report token;
 * partner tokens are refused (403).
 *
 * The URL is returned exactly once, at creation (the server cannot rebuild
 * it — the token is stored hashed). Lists carry ids + lifetimes only.
 */
export interface ShareLinkCreateRequest {
  readonly reportToken: string;
}

export interface ShareLinkCreateResponse {
  readonly id: string;
  /** The read-only report URL to copy. Shown once. */
  readonly url: string;
  /** ISO-8601 expiry (SHARE_LINK_TTL_SECONDS from creation). */
  readonly expiresAt: string;
}

export type ShareLinkStatus = 'active' | 'expired' | 'revoked';

export interface ShareLinkSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ShareLinkStatus;
}

export interface ShareLinkListRequest {
  readonly reportToken: string;
}

export interface ShareLinkListResponse {
  /** Newest first. */
  readonly links: readonly ShareLinkSummary[];
}

export interface ShareLinkRevokeRequest {
  readonly reportToken: string;
  readonly shareId: string;
}

export interface ShareLinkRevokeResponse {
  readonly id: string;
  readonly status: 'revoked';
}
