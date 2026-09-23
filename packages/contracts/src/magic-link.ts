/**
 * Magic-link contracts. Token hashing/comparison is server-side; the client only
 * ever holds the opaque token from the URL and the report token it resolves to.
 */

export interface MagicLinkVerifySuccess {
  readonly valid: true;
  readonly reportToken: string;
  readonly estimateId: string;
  readonly leadId: string;
}

export interface MagicLinkVerifyFailure {
  readonly valid: false;
  readonly reason: 'expired' | 'invalid';
  readonly reissueAllowed: boolean;
}

export type MagicLinkVerifyResponse =
  | MagicLinkVerifySuccess
  | MagicLinkVerifyFailure;

export interface MagicLinkReissueRequest {
  readonly email: string;
}

export interface MagicLinkReissueResponse {
  readonly sent: boolean;
}
