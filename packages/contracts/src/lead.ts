/**
 * Lead-gate contracts. The lead is persisted even if the magic link is never
 * clicked — capture first, verify after.
 */

export type TimelineOption =
  | '0-3mo'
  | '3-6mo'
  | '6-12mo'
  | '12+mo'
  | 'exploring';

export interface LeadRequest {
  readonly email: string;
  readonly name: string;
  readonly phone?: string;
  readonly timeline: TimelineOption;
  /** CASL marketing consent. Unchecked by default in the UI. */
  readonly marketingConsent: boolean;
  readonly estimateId: string;
  /** Present only on builder embeds. */
  readonly tenantKey?: string;
}

export interface LeadResponse {
  readonly leadId: string;
  readonly magicLinkSent: boolean;
  /** Rendered in the UI from this value — never hardcoded. */
  readonly expiresInDays: number;
}
