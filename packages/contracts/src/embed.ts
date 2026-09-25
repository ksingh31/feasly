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

/** Iframe → parent page: content height, so the host can resize the iframe. */
export interface EmbedResizeMessage {
  readonly type: 'feasly:resize';
  readonly height: number;
}

/** Messages the parent page sends into the iframe. */
export type EmbedParentMessage = EmbedThemeMessage;

/** Messages the iframe sends out to the parent page. */
export type EmbedIframeMessage = EmbedResizeMessage;

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
