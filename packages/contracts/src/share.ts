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
