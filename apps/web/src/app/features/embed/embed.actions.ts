import type { EmbedPublicConfig } from '@feasly/contracts';

/** NGXS action: resolve the builder config for a tenant key (EMB-01). */
export class LoadEmbedConfig {
  static readonly type = '[Embed] Load config';
  constructor(public readonly tenantKey: string) {}
}

/** NGXS action: the builder config resolved (EMB-02 wire shape). */
export class EmbedConfigLoaded {
  static readonly type = '[Embed] Config loaded';
  constructor(public readonly config: EmbedPublicConfig) {}
}

/**
 * NGXS action: the builder config could not be resolved — missing key,
 * unknown/revoked tenant, or network failure. The shell shows the
 * story-pinned fallback card; `reason` is a short machine code for logs,
 * never user-facing copy.
 */
export class EmbedConfigFailed {
  static readonly type = '[Embed] Config failed';
  constructor(public readonly reason: string) {}
}
