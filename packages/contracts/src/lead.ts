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
  /**
   * Honeypot anti-spam field (HRD-03). The UI renders this input visually
   * hidden; a real user never fills it. Any non-empty value marks the lead
   * as quarantined server-side — the caller still gets the normal 201-shaped
   * response so bots learn nothing.
   */
  readonly website?: string;
}

export interface LeadResponse {
  readonly leadId: string;
  readonly magicLinkSent: boolean;
  /** Rendered in the UI from this value — never hardcoded. */
  readonly expiresInDays: number;
  /**
   * Owner report token minted at submit time (Karan directive 2026-09-27:
   * the submitted lead unlocks the report immediately — the magic-link
   * email is return-access for other devices, not the unlock key for this
   * session). Lets the same-session report use the token-gated extras
   * (partner share, callback, narrative, token revise) without waiting for
   * the email round-trip. Omitted for quarantined (suspected-bot) captures
   * and by backends that predate this field — the UI falls back to the
   * honest token-error state in those cases.
   */
  readonly reportToken?: string;
  /**
   * 0–100 lead score computed server-side (embed/08). Optional: backends
   * that predate the embed bridge omit it; the bridge posts the
   * lead-created event regardless.
   */
  readonly leadScore?: number;
}
