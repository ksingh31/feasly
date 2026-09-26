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

/**
 * NGXS action: exchange the one-time relay code (embed/06).
 *
 * The builder snippet posts `feasly:relay {code}` into the iframe (from
 * `?feasly_rt=` in the builder page URL). The shell accepts it once per
 * boot, exchanges it via `POST /api/v1/embed/session`, and on success
 * holds the 12h session token in memory (never localStorage, never a
 * cookie — privacy-strict by design).
 */
export class ExchangeRelayCode {
  static readonly type = '[Embed] Exchange relay code';
  constructor(public readonly code: string) {}
}

/** NGXS action: the relay exchange succeeded — the session is live. */
export class RelaySessionEstablished {
  static readonly type = '[Embed] Relay session established';
  constructor(
    public readonly sessionToken: string,
    public readonly estimateId: string,
    public readonly leadScore: number,
  ) {}
}

/**
 * NGXS action: the relay exchange failed — expired/used/invalid code or
 * tenant mismatch. The shell shows the "session expired" state with a
 * one-tap "Email me a fresh link"; `reason` is a machine code for logs,
 * never user-facing copy.
 */
export class RelaySessionFailed {
  static readonly type = '[Embed] Relay session failed';
  constructor(public readonly reason: string) {}
}
