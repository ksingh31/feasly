/**
 * Builder-embed contracts: tenant config, the postMessage handshake, and the
 * one-time relay code that carries auth back to the builder page.
 *
 * Directionality matters here — the parent page and the iframe speak different
 * message sets, and the types keep them apart.
 */

export interface EmbedTenantConfig {
  readonly tenantKey: string;
  readonly builderName: string;
  readonly logoUrl?: string;
  /** Hex color, applied to CTAs after the theme handshake. */
  readonly primaryColor: string;
  /** Parent origin allowlist entry. Never '*' in production builds. */
  readonly allowedOrigin: string;
  readonly poweredByBadge: boolean;
}

/** Parent page → iframe: the builder's theme handshake. */
export interface EmbedThemeMessage {
  readonly type: 'feasly:theme';
  readonly primaryColor: string;
}

/** Iframe → parent page: the shell has booted and is ready for commands. */
export interface EmbedReadyMessage {
  readonly type: 'feasly:ready';
}

/** Iframe → parent page: content height, so the host can resize the iframe. */
export interface EmbedResizeMessage {
  readonly type: 'feasly:resize';
  readonly height: number;
}

/**
 * Iframe → parent page: the user picked an address and started an estimate.
 * The parent owns what happens next (analytics, navigation).
 */
export interface EmbedEstimateStartMessage {
  readonly type: 'feasly:estimate-start';
  readonly addressKey?: string;
  readonly address?: string;
}

/**
 * Iframe → parent page: a lead was created. Posted exactly once per lead.
 * NO PII EVER — only the opaque estimate ID and the numeric lead score,
 * safe for the builder's analytics.
 */
export interface EmbedLeadCreatedMessage {
  readonly type: 'feasly:lead-created';
  readonly estimateId: string;
  /**
   * 0–100 lead score from the backend. Optional: older backends that do not
   * yet return leadScore in LeadResponse will omit it; the bridge posts
   * the event regardless so builders never miss a conversion.
   */
  readonly leadScore?: number;
}

/**
 * Iframe → parent page: the embed/06 relay handshake completed and the
 * session is established. Carries only the opaque estimate ID (NO PII)
 * for the builder's analytics.
 */
export interface EmbedAuthOkMessage {
  readonly type: 'FEASLY_AUTH_OK';
  readonly estimateId?: string;
}

/** Parent → iframe: single-use relay code for the embed/06 auth handoff. */
export interface EmbedRelayMessage {
  readonly type: 'feasly:relay';
  readonly code: string;
}

/** Messages the parent page sends into the iframe. */
export type EmbedParentMessage = EmbedThemeMessage | EmbedRelayMessage;

/** Messages the iframe sends out to the parent page. */
export type EmbedIframeMessage =
  | EmbedReadyMessage
  | EmbedResizeMessage
  | EmbedEstimateStartMessage
  | EmbedLeadCreatedMessage
  | EmbedAuthOkMessage;

/** 32-byte single-use relay code, 10-minute life. Crypto enforced server-side. */
export interface EmbedRelayCode {
  readonly code: string;
  readonly expiresInSeconds: number;
}

/**
 * Public builder config served by GET /api/v1/embed/config (EMB-02).
 *
 * Snake_case: this is the wire shape. `logo_url` may be '' — the embed
 * shell falls back to the Feasly wordmark. `plan` is inert until billing
 * lands (embed/04); null = undecided (the default for every tenant).
 */
export interface EmbedPublicConfig {
  readonly business_name: string;
  readonly display_name: string;
  readonly logo_url: string;
  /** Hex color (#rrggbb), applied as a CSS custom property by the embed shell. */
  readonly accent_color: string;
  readonly allowed_origins: readonly string[];
  readonly fallback_phone: string;
  readonly fallback_email: string;
  readonly plan: 'flat' | 'commission' | null;
}
