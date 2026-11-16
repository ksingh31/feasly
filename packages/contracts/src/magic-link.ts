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

/**
 * #800 — returning users: the household estimate list behind the emailed
 * link. Only HOUSEHOLD links (minted by the reissue path and delivered by
 * email — possession proves control of the inbox) list anything. Owner
 * tokens handed back in the lead-submit response prove nothing about the
 * email, so they list only their own report (a single item → the UI opens
 * it directly, same as today). Partner-share, expired, revoked and erased
 * tokens answer with the `MagicLinkVerifyFailure` shape.
 */
export interface MagicLinkEstimateItem {
  /**
   * Opaque per-estimate handle. Opens the report via
   * `POST /api/v1/magic-link/estimates/open` together with the household
   * token — it is NOT a credential on its own.
   */
  readonly handle: string;
  /** Display-formatted property address. */
  readonly address: string;
  /** ISO-8601 timestamp the estimate was prepared. */
  readonly preparedAt: string;
  /** Which engine branch produced the estimate. */
  readonly projectType: 'new_build' | 'renovation';
  /** True for the newest estimate (the first item). */
  readonly latest: boolean;
  /**
   * True when the presented token already opens this report — the UI can
   * navigate with the token it holds instead of calling open.
   */
  readonly current: boolean;
}

export interface MagicLinkEstimatesSuccess {
  readonly valid: true;
  /** Up to 10 items, newest first — one per property. */
  readonly estimates: readonly MagicLinkEstimateItem[];
}

/** `GET /api/v1/magic-link/estimates?token=`. */
export type MagicLinkEstimatesResponse =
  | MagicLinkEstimatesSuccess
  | MagicLinkVerifyFailure;

/** `POST /api/v1/magic-link/estimates/open`. */
export interface MagicLinkEstimateOpenRequest {
  /** The household token from the emailed link. */
  readonly token: string;
  /** `MagicLinkEstimateItem.handle` from the list. */
  readonly handle: string;
}

export interface MagicLinkEstimateOpenSuccess {
  readonly valid: true;
  /**
   * Owner report token for the chosen estimate — open `/r/{reportToken}`.
   * Never outlives the household token that minted it.
   */
  readonly reportToken: string;
}

export type MagicLinkEstimateOpenResponse =
  | MagicLinkEstimateOpenSuccess
  | MagicLinkVerifyFailure;
