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
