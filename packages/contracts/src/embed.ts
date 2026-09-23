/**
 * Builder-embed contracts: tenant config, the postMessage handshake, and the
 * one-time relay code that carries auth back to the builder page.
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

export interface EmbedThemeMessage {
  readonly type: 'feasly:theme';
  readonly primaryColor: string;
}

export interface EmbedResizeMessage {
  readonly type: 'feasly:resize';
  readonly height: number;
}

export type EmbedParentMessage = EmbedThemeMessage | EmbedResizeMessage;

/** 32-byte single-use relay code, 10-minute life. Crypto enforced server-side. */
export interface EmbedRelayCode {
  readonly code: string;
  readonly expiresInSeconds: number;
}
