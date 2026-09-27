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
 * the share was sent to.
 */
export interface PartnerShareVerifySuccess {
  readonly valid: true;
  readonly reportToken: string;
  readonly estimateId: string;
  readonly partnerEmail: string;
}

export interface PartnerShareVerifyFailure {
  readonly valid: false;
  readonly reason: 'expired' | 'invalid';
}

export type PartnerShareVerifyResponse =
  | PartnerShareVerifySuccess
  | PartnerShareVerifyFailure;
