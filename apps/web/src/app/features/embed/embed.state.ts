import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { catchError, EMPTY, map } from 'rxjs';
import type { EmbedPublicConfig } from '@feasly/contracts';
import type { ApiError } from '@feasly/contracts';
import {
  EmbedConfigFailed,
  EmbedConfigLoaded,
  ExchangeRelayCode,
  LoadEmbedConfig,
  RelaySessionEstablished,
  RelaySessionFailed,
  ResendRelayCode,
} from './embed.actions';
import { EmbedConfigService } from './embed-config.service';

/** Embed shell lifecycle (EMB-01). */
export type EmbedStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Relay session lifecycle (embed/06). */
export type RelayStatus = 'none' | 'exchanging' | 'active' | 'failed';

export interface EmbedStateModel {
  /** Tenant key from the URL (`?key=` or `:tenantKey`). Null until resolved. */
  tenantKey: string | null;
  /** Builder config from EMB-02. Null until loaded. */
  config: EmbedPublicConfig | null;
  status: EmbedStatus;
  /** Machine-readable failure code (unknown_tenant, http_0, …). Never user-facing. */
  error: string | null;
  /** Relay-code exchange state (embed/06). */
  relayStatus: RelayStatus;
  /**
   * 12h session token from `POST /api/v1/embed/session`. Held ONLY in
   * memory — this state is deliberately NOT in the storage-plugin keys,
   * so the token can never leak into localStorage or across visits.
   */
  sessionToken: string | null;
  /** Estimate the relay session is bound to. */
  sessionEstimateId: string | null;
  /** Lead score echoed to the parent via FEASLY_AUTH_OK (no PII). */
  sessionLeadScore: number | null;
  /** Machine-readable relay failure code. Never user-facing. */
  relayError: string | null;
  /**
   * The relay code presented for exchange (embed/06 AC3). Memory-only —
   * kept so the "session expired" state can re-issue a fresh code for it
   * without ever touching storage. Cleared once a session is active.
   */
  relayCode: string | null;
  /** A resend request is in flight (the fresh-link button shows busy). */
  resending: boolean;
  /**
   * Machine-readable resend failure ('cooldown' | 'failed'). Never
   * user-facing; the shell maps it to plain copy.
   */
  resendError: string | null;
}

/**
 * Embed state (EMB-01): the single source of truth for the white-label
 * shell. Session-scoped — deliberately NOT in the storage-plugin keys, so
 * a stale builder config can never leak across tenants or visits. The
 * config is re-fetched from `?key=` on every load.
 *
 * Embed/06 extends this with the relay session: the one-time code from
 * `?feasly_rt=` is exchanged for a 12h session token that lives only in
 * this in-memory state. Reloading the iframe before the exchange completes
 * simply re-runs the exchange — the code is single-use, so a second load
 * sees 410 and shows the "session expired" re-issue state.
 */
@State<EmbedStateModel>({
  name: 'embed',
  defaults: {
    tenantKey: null,
    config: null,
    status: 'idle',
    error: null,
    relayStatus: 'none',
    sessionToken: null,
    sessionEstimateId: null,
    sessionLeadScore: null,
    relayError: null,
    relayCode: null,
    resending: false,
    resendError: null,
  },
})
@Injectable()
export class EmbedState {
  private readonly configs = inject(EmbedConfigService);

  @Selector()
  static status(state: EmbedStateModel): EmbedStatus {
    return state.status;
  }

  @Selector()
  static config(state: EmbedStateModel): EmbedPublicConfig | null {
    return state.config;
  }

  @Selector()
  static tenantKey(state: EmbedStateModel): string | null {
    return state.tenantKey;
  }

  @Selector()
  static relayStatus(state: EmbedStateModel): RelayStatus {
    return state.relayStatus;
  }

  @Selector()
  static sessionToken(state: EmbedStateModel): string | null {
    return state.sessionToken;
  }

  @Selector()
  static sessionEstimateId(state: EmbedStateModel): string | null {
    return state.sessionEstimateId;
  }

  @Selector()
  static sessionLeadScore(state: EmbedStateModel): number | null {
    return state.sessionLeadScore;
  }

  @Selector()
  static resending(state: EmbedStateModel): boolean {
    return state.resending;
  }

  @Selector()
  static resendError(state: EmbedStateModel): string | null {
    return state.resendError;
  }

  @Action(LoadEmbedConfig)
  load(ctx: StateContext<EmbedStateModel>, action: LoadEmbedConfig) {
    ctx.patchState({ tenantKey: action.tenantKey, config: null, status: 'loading', error: null });
    return this.configs.getConfig(action.tenantKey).pipe(
      map((config) => ctx.dispatch(new EmbedConfigLoaded(config))),
      // ctx.dispatch() already returns an observable — return it directly.
      catchError((err: unknown) =>
        ctx.dispatch(
          new EmbedConfigFailed(
            typeof (err as ApiError)?.code === 'string' ? (err as ApiError).code : 'unknown',
          ),
        ),
      ),
    );
  }

  @Action(EmbedConfigLoaded)
  loaded(ctx: StateContext<EmbedStateModel>, action: EmbedConfigLoaded) {
    ctx.patchState({ config: action.config, status: 'ready', error: null });
  }

  @Action(EmbedConfigFailed)
  failed(ctx: StateContext<EmbedStateModel>, action: EmbedConfigFailed) {
    ctx.patchState({ config: null, status: 'error', error: action.reason });
  }

  @Action(ExchangeRelayCode)
  exchangeRelay(ctx: StateContext<EmbedStateModel>, action: ExchangeRelayCode) {
    const state = ctx.getState();
    // Accept once per boot: a second relay for an already-active or
    // in-flight session is ignored (the loader clears the code after
    // FEASLY_AUTH_OK, so duplicates only come from re-posts).
    if (state.relayStatus === 'exchanging' || state.relayStatus === 'active') {
      return EMPTY;
    }
    const tenantKey = state.tenantKey;
    if (tenantKey === null) {
      return ctx.dispatch(new RelaySessionFailed('no_tenant'));
    }
    ctx.patchState({ relayStatus: 'exchanging', relayError: null, relayCode: action.code });
    return this.configs
      .exchangeRelayCode({ code: action.code, tenant_key: tenantKey })
      .pipe(
        map((res) =>
          ctx.dispatch(
            new RelaySessionEstablished(res.sessionToken, res.estimateId, res.leadScore),
          ),
        ),
        catchError((err: unknown) =>
          ctx.dispatch(
            new RelaySessionFailed(
              typeof (err as ApiError)?.code === 'string' ? (err as ApiError).code : 'unknown',
            ),
          ),
        ),
      );
  }

  @Action(RelaySessionEstablished)
  relayEstablished(ctx: StateContext<EmbedStateModel>, action: RelaySessionEstablished) {
    ctx.patchState({
      relayStatus: 'active',
      sessionToken: action.sessionToken,
      sessionEstimateId: action.estimateId,
      sessionLeadScore: action.leadScore,
      relayError: null,
      relayCode: null,
      resending: false,
      resendError: null,
    });
  }

  @Action(RelaySessionFailed)
  relayFailed(ctx: StateContext<EmbedStateModel>, action: RelaySessionFailed) {
    ctx.patchState({
      relayStatus: 'failed',
      sessionToken: null,
      sessionEstimateId: null,
      sessionLeadScore: null,
      relayError: action.reason,
      resending: false,
    });
  }

  /**
   * Re-issue a fresh relay code for the expired/used one (embed/06 AC3).
   * The state calls `POST /api/v1/embed/relay/resend` with the presented
   * code and immediately exchanges the fresh code it returns. A 429
   * (RATE_LIMITED — the 60s per-code cooldown) surfaces as
   * `resendError: 'cooldown'` so the shell can say "wait a minute";
   * anything else is `'failed'`.
   */
  @Action(ResendRelayCode)
  resendRelay(ctx: StateContext<EmbedStateModel>) {
    const state = ctx.getState();
    if (state.resending) return EMPTY;
    const tenantKey = state.tenantKey;
    const code = state.relayCode;
    if (tenantKey === null || code === null) {
      return ctx.dispatch(new RelaySessionFailed('no_resend_context'));
    }
    ctx.patchState({ resending: true, resendError: null });
    return this.configs.resendRelayCode({ code, tenant_key: tenantKey }).pipe(
      map((res) => ctx.dispatch(new ExchangeRelayCode(res.code))),
      catchError((err: unknown) => {
        const apiCode = (err as ApiError)?.code;
        ctx.patchState({
          resending: false,
          resendError: apiCode === 'RATE_LIMITED' ? 'cooldown' : 'failed',
        });
        return EMPTY;
      }),
    );
  }
}
